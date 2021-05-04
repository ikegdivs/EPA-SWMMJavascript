//-----------------------------------------------------------------------------
//   climate.c
//
//   Project: EPA SWMM5
//   Version: 5.1
//   Date:    03/20/10 (Build 5.1.001)
//            09/15/14 (Build 5.1.007)
//            03/19/15 (Build 5.1.008)
//            08/05/15 (Build 5.1.010)
//            08/01/16 (Build 5.1.011)
//            05/10/18 (Build 5.1.013)
//   Author:  L. Rossman
//
//   Climate related functions.
//
//   Build 5.1.007:
//   - NCDC GHCN climate file format added.
//   - Monthly adjustments for temperature, evaporation & rainfall added.
//
//   Build 5.1.008:
//   - Monthly adjustments for hyd. conductivity added.
//   - Time series evaporation rates can now vary within a day.
//   - Evaporation rates are now properly updated when only flow routing
//     is being simulated.
//
//   Build 5.1.010:
//   - Hargreaves evaporation now computed using 7-day average temperatures.
//             
//   Build 5.1.011:
//   - Monthly adjustment for hyd. conductivity <= 0 is ignored.
//
//   Build 5.1.013:
//   - Reads names of monthly adjustment patterns for various parameters
//     of a subcatchment from the [ADJUSTMENTS] section of input file.
///-----------------------------------------------------------------------------


//-----------------------------------------------------------------------------
//  Constants
//-----------------------------------------------------------------------------
//enum ClimateFileFormats {
var UNKNOWN_FORMAT = 0
var USER_PREPARED = 0     // SWMM 5's own user format
var GHCND = 0             // NCDC GHCN Daily format
var TD3200 = 0            // NCDC TD3200 format
var DLY0204 = 0          // Canadian DLY02 or DLY04 format
var MAXCLIMATEVARS  = 4;
var MAXDAYSPERMONTH = 32;

// These variables are used when processing climate files.
//enum   ClimateVarType {TMIN, TMAX, EVAP, WIND};
var TMIN = 0
var TMAX = 1
var EVAP = 2
var WIND = 3
//enum   WindSpeedType  {WDMV, AWND};
var WDMV = 0
var AWND = 0
ClimateVarWords = ["TMIN", "TMAX", "EVAP", "WDMV", "AWND",
                                  null];

//-----------------------------------------------------------------------------
//  Data Structures
//-----------------------------------------------------------------------------
class TMovAve
{
    constructor(){
        this.tAve;          // moving avg. for daily temperature (deg F)
        this.tRng;          // moving avg. for daily temp. range (deg F)
        this.ta = new Array(7);         // data window for tAve
        this.tr = new Array(7);         // data window for tRng
        this.count;         // length of moving average window
        this.maxCount;      // maximum length of moving average window
        this.front;         // index of front of moving average window
    }
} ;


//-----------------------------------------------------------------------------
//  Shared variables
//-----------------------------------------------------------------------------
// Temperature variables
var Tmin;                 // min. daily temperature (deg F)
var    Tmax;                 // max. daily temperature (deg F)
var    Trng;                 // 1/2 range of daily temperatures
var    Trng1;                // prev. max - current min. temp.
var    Tave;                 // average daily temperature (deg F)
var    Hrsr;                 // time of min. temp. (hrs)
var    Hrss;                 // time of max. temp (hrs)
var    Hrday;                // avg. of min/max temp times
var    Dhrdy;                // hrs. between min. & max. temp. times
var    Dydif;                // hrs. between max. & min. temp. times
var  LastDay;              // date of last day with temp. data
//static TMovAve   Tma;                  // moving average of daily temperatures
var Tma;

// Evaporation variables
var  NextEvapDate;         // next date when evap. rate changes
var    NextEvapRate;         // next evaporation rate (user units)

// Climate file variables
var      FileFormat;            // file format (see ClimateFileFormats)
var      FileYear;              // current year of file data
var      FileMonth;             // current month of year of file data
var      FileDay;               // current day of month of file data
var      FileLastDay;           // last day of current month of file data
var      FileElapsedDays;       // number of days read from file
var   FileValue = new Array(4);          // current day's values of climate data
var   FileData = Array.from(Array(4), () => new Array(32)) // [4][32];       // month's worth of daily climate data
var   FileLine;   // line from climate data file

var      FileFieldPos = new Array(4);       // start of data fields for file record
var      FileDateFieldPos;      // start of date field for file record 
var      FileWindType;          // wind speed type

//-----------------------------------------------------------------------------
//  External functions (defined in funcs.h)
//-----------------------------------------------------------------------------
//  climate_readParams                 // called by input_parseLine
//  climate_readEvapParams             // called by input_parseLine
//  climate_validate                   // called by project_validate
//  climate_openFile                   // called by runoff_open
//  climate_initState                  // called by project_init
//  climate_setState                   // called by runoff_execute
//  climate_getNextEvapDate            // called by runoff_getTimeStep


//=============================================================================
// char* tok[], int ntoks
function  climate_readParams(tok, ntoks)
//
//  Input:   tok[] = array of string tokens
//           ntoks = number of tokens
//  Output:  returns error code
//  Purpose: reads climate/temperature parameters from input line of data
//
//  Format of data can be
//    TIMESERIES  name
//    FILE        name
//    WINDSPEED   MONTHLY  v1  v2  ...  v12
//    WINDSPEED   FILE
//    SNOWMELT    v1  v2  ...  v6
//    ADC         IMPERV/PERV  v1  v2  ...  v10
//
{
    let i, j, k;
    let x = new Array(6)
    let y;
    let aDate;

    // return facilitators
    let returnObj;
    let returnVal;

    // --- identify keyword
    k = findmatch(tok[0], TempKeyWords);
    if ( k < 0 ) return error_setInpError(ERR_KEYWORD, tok[0]);
    switch (k)
    {
      case 0: // Time series name
        // --- check that time series name exists
        if ( ntoks < 2 ) return error_setInpError(ERR_ITEMS, "");
        i = project_findObject(TSERIES, tok[1]);
        if ( i < 0 ) return error_setInpError(ERR_NAME, tok[1]);

        // --- record the time series as being the data source for temperature
        Temp.dataSource = TSERIES_TEMP;
        Temp.tSeries = i;
        Tseries[i].refersTo = TSERIES_TEMP;
        break;

      case 1: // Climate file
        // --- record file as being source of temperature data
        if ( ntoks < 2 ) return error_setInpError(ERR_ITEMS, "");
        Temp.dataSource = FILE_TEMP;

        // --- save name and usage mode of external climate file
        Fclimate.mode = USE_FILE;
        sstrncpy(Fclimate.name, tok[1], MAXFNAME);

        // --- save starting date to read from file if one is provided
        Temp.fileStartDate = NO_DATE;
        if ( ntoks > 2 )
        {
            if ( tok[2] != '*')
            {
                ////////////////////////////////////
                returnObj = {d: aDate}
                returnVal = datetime_strToDate(tok[2], returnObj);
                aDate = returnObj.d;
                ////////////////////////////////////
                //if ( !datetime_strToDate(tok[2], aDate) )
                if( !returnVal)
                    return error_setInpError(ERR_DATETIME, tok[2]);
                Temp.fileStartDate = aDate;
            }
        }
        break;

      case 2: // Wind speeds
        // --- check if wind speeds will be supplied from climate file
        if ( strcomp(tok[1], w_FILE) )
        {
            Wind.type = FILE_WIND;
        }

        // --- otherwise read 12 monthly avg. wind speed values
        else
        {
            if ( ntoks < 14 ) return error_setInpError(ERR_ITEMS, "");
            Wind.type = MONTHLY_WIND;
            for (i=0; i<12; i++)
            {
                ////////////////////////////////////
                returnObj = {y: y}
                returnVal = getDouble(tok[i+2], returnObj);
                y = returnObj.y;
                ////////////////////////////////////
                if (!returnVal)
                //if ( !getDouble(tok[i+2], &y) )
                    return error_setInpError(ERR_NUMBER, tok[i+2]);
                Wind.aws[i] = y;
            }
        }
        break;

      case 3: // Snowmelt params
        if ( ntoks < 7 ) return error_setInpError(ERR_ITEMS, "");
        for (i=1; i<7; i++)
        {
            ////////////////////////////////////
            returnObj = {y: x[i-1]}
            returnVal = getDouble(tok[i], returnObj);
            x[i-1] = returnObj.y;
            ////////////////////////////////////
            if (!returnVal)
            //if ( null == (x[i-1] = getDouble(tok[i])) )
                return error_setInpError(ERR_NUMBER, tok[i]);
        }
        // --- convert deg. C to deg. F for snowfall temperature
        if ( UnitSystem == SI ) x[0] = 9./5.*x[0] + 32.0;
        Snow.snotmp = x[0];
        Snow.tipm   = x[1];
        Snow.rnm    = x[2];
        Temp.elev   = x[3] / UCF(LENGTH);
        Temp.anglat = x[4];
        Temp.dtlong = x[5] / 60.0;
        break;

      case 4:  // Areal Depletion Curve data
        // --- check if data is for impervious or pervious areas
        if ( ntoks < 12 ) return error_setInpError(ERR_ITEMS, "");
        if      ( match(tok[1], w_IMPERV) ) i = 0;
        else if ( match(tok[1], w_PERV)   ) i = 1;
        else return error_setInpError(ERR_KEYWORD, tok[1]);

        // --- read 10 fractional values
        for (j=0; j<10; j++)
        {
            ////////////////////////////////////
            returnObj = {y: y}
            returnVal = getDouble(tok[j+2], returnObj);
            y = returnObj.y;
            ////////////////////////////////////
            if (!returnVal || y < 0.0 || y > 1.0 )
            //if ( null == (y = getDouble(tok[j+2])) || y < 0.0 || y > 1.0 )
                return error_setInpError(ERR_NUMBER, tok[j+2]);
            Snow.adc[i][j] = y;
        }
        break;
    }
    return 0;
}

//=============================================================================
// char* tok[], int ntoks
function climate_readEvapParams(tok, ntoks)
//
//  Input:   tok[] = array of string tokens
//           ntoks = number of tokens
//  Output:  returns error code
//  Purpose: reads evaporation parameters from input line of data.
//
//  Data formats are:
//    CONSTANT  value
//    MONTHLY   v1 ... v12
//    TIMESERIES name
//    TEMPERATURE
//    FILE      (v1 ... v12)
//    RECOVERY   name
//    DRY_ONLY   YES/NO
//
{
    let i, k;
    let x;

    // return facilitators
    let returnObj;
    let returnVal;

    // --- find keyword indicating what form the evaporation data is in
    k = findmatch(tok[0], EvapTypeWords);
    if ( k < 0 ) return error_setInpError(ERR_KEYWORD, tok[0]);

    // --- check for RECOVERY pattern data
    if ( k == RECOVERY )
    {
        if ( ntoks < 2 ) return error_setInpError(ERR_ITEMS, "");
        i = project_findObject(TIMEPATTERN, tok[1]);
        if ( i < 0 ) return error_setInpError(ERR_NAME, tok[1]);
        Evap.recoveryPattern = i;
        return 0;
    }

    // --- check for no evaporation in wet periods
    if ( k == DRYONLY )
    {
        if ( ntoks < 2 ) return error_setInpError(ERR_ITEMS, "");
        if      ( strcomp(tok[1], w_NO ) )  Evap.dryOnly = FALSE;
        else if ( strcomp(tok[1], w_YES ) ) Evap.dryOnly = TRUE;
        else return error_setInpError(ERR_KEYWORD, tok[1]);
        return 0;
    }

    // --- process data depending on its form
    Evap.type = k;
    if ( k != TEMPERATURE_EVAP && ntoks < 2 )
        return error_setInpError(ERR_ITEMS, "");
    switch ( k )
    {
      case CONSTANT_EVAP:
        // --- for constant evap., fill monthly avg. values with same number
        ////////////////////////////////////
        returnObj = {y: x}
        returnVal = getDouble(tok[1], returnObj);
        x = returnObj.y;
        ////////////////////////////////////
        if(!returnVal)
        //if ( null == (x = getDouble(tok[1])) )
            return error_setInpError(ERR_NUMBER, tok[1]);
        for (i=0; i<12; i++) Evap.monthlyEvap[i] = x;
        break;

      case MONTHLY_EVAP:
        // --- for monthly evap., read a value for each month of year
        if ( ntoks < 13 ) return error_setInpError(ERR_ITEMS, "");
        for ( i=0; i<12; i++)
            ////////////////////////////////////
            returnObj = {y: Evap.monthlyEvap[i]}
            returnVal = getDouble(tok[i+1], returnObj);
            Evap.monthlyEvap[i] = returnObj.y;
            ////////////////////////////////////
            if(!returnVal)
            //if ( null == (Evap.monthlyEvap[i] = getDouble(tok[i+1])))
                return error_setInpError(ERR_NUMBER, tok[i+1]);
        break;

      case TIMESERIES_EVAP:
        // --- for time series evap., read name of time series
        i = project_findObject(TSERIES, tok[1]);
        if ( i < 0 ) return error_setInpError(ERR_NAME, tok[1]);
        Evap.tSeries = i;
        Tseries[i].refersTo = TIMESERIES_EVAP;
        break;

      case FILE_EVAP:
        // --- for evap. from climate file, read monthly pan coeffs.
        //     if they are provided (default values are 1.0)
        if ( ntoks > 1 )
        {
            if ( ntoks < 13 ) return error_setInpError(ERR_ITEMS, "");
            for (i=0; i<12; i++)
            {
                ////////////////////////////////////
                returnObj = {y: Evap.panCoeff[i]}
                returnVal = getDouble(tok[i+1], returnObj);
                Evap.panCoeff[i] = returnObj.y;
                ////////////////////////////////////
                if(!returnVal)
                //if ( null == (Evap.panCoeff[i] = getDouble(tok[i+1])) )
                    return error_setInpError(ERR_NUMBER, tok[i+1]);
            }
        }
        break;
    }
    return 0;
}

//=============================================================================
// char* tok[], int ntoks
function climate_readAdjustments(tok, ntoks)
//
//  Input:   tok[] = array of string tokens
//           ntoks = number of tokens
//  Output:  returns error code
//  Purpose: reads adjustments to monthly evaporation or rainfall
//           from input line of data.
//
//  Data formats are:
//    TEMPERATURE   v1 ... v12
//    EVAPORATION   v1 ... v12
//    RAINFALL      v1 ... v12
//    CONDUCTIVITY  v1 ... v12
//    N-PERV        subcatchID  patternID                                      //(5.1.013
//    DSTORE        subcatchID  patternID                                      //
//    INFIL         subcatchID  patternID                                      //
{
    let i, j;                                                                  //(5.1.013)

    // return facilitators
    let returnObj;
    let returnVal;

    if (ntoks == 1) return 0;

    if ( match(tok[0], "TEMP") )
    {
        if ( ntoks < 13 )  return error_setInpError(ERR_ITEMS, "");
        for (i = 1; i < 13; i++)
        {
            ////////////////////////////////////
            returnObj = {y: Adjust.temp[i-1]}
            returnVal = getDouble(tok[i], returnObj);
            Adjust.temp[i-1] = returnObj.y;
            ////////////////////////////////////
            if(!returnVal)
            //if ( null == (Adjust.temp[i-1] = getDouble(tok[i])) )
                return error_setInpError(ERR_NUMBER, tok[i]);
        }
        return 0;
    }

    if ( match(tok[0], "EVAP") )
    {
        if ( ntoks < 13 )  return error_setInpError(ERR_ITEMS, "");
        for (i = 1; i < 13; i++)
        {
            ////////////////////////////////////
            returnObj = {y: Adjust.evap[i-1]}
            returnVal = getDouble(tok[i], returnObj);
            Adjust.evap[i-1] = returnObj.y;
            ////////////////////////////////////
            if(!returnVal)
            //if ( null == (Adjust.evap[i-1] = getDouble(tok[i])))
                return error_setInpError(ERR_NUMBER, tok[i]);
        }
        return 0;
    }

    if ( match(tok[0], "RAIN") )
    {
        if ( ntoks < 13 )  return error_setInpError(ERR_ITEMS, "");
        for (i = 1; i < 13; i++)
        {
            ////////////////////////////////////
            returnObj = {y: Adjust.rain[i-1]}
            returnVal = getDouble(tok[i], returnObj);
            Adjust.rain[i-1] = returnObj.y;
            ////////////////////////////////////
            if(!returnVal)
            //if ( null == (Adjust.rain[i-1] = getDouble(tok[i])))
                return error_setInpError(ERR_NUMBER, tok[i]);
        }
        return 0;
    }

    if ( match(tok[0], "CONDUCT") )
    {
        if ( ntoks < 13 )  return error_setInpError(ERR_ITEMS, "");
        for (i = 1; i < 13; i++)
        {
            ////////////////////////////////////
            returnObj = {y: Adjust.hydcon[i-1]}
            returnVal = getDouble(tok[i], returnObj);
            Adjust.hydcon[i-1] = returnObj.y;
            ////////////////////////////////////
            if(!returnVal)
            //if ( null == (Adjust.hydcon[i-1] = getDouble(tok[i])))
                return error_setInpError(ERR_NUMBER, tok[i]);
            if ( Adjust.hydcon[i-1] <= 0.0 ) Adjust.hydcon[i-1] = 1.0;
        }
        return 0;
    }

////  Following code segments added to release 5.1.013.  ////                  //(5.1.013)
    if ( match(tok[0], "N-PERV") )
    {
        if ( ntoks < 3 ) return error_setInpError(ERR_ITEMS, "");
        i = project_findObject(SUBCATCH, tok[1]);
        if (i < 0) return error_setInpError(ERR_NAME, tok[1]);
        j = project_findObject(TIMEPATTERN, tok[2]);
        if (j < 0) return error_setInpError(ERR_NAME, tok[2]);
        Subcatch[i].nPervPattern = j;
        return 0;
    }

    if ( match(tok[0], "DSTORE") )
    {
        if (ntoks < 3) return error_setInpError(ERR_ITEMS, "");
        i = project_findObject(SUBCATCH, tok[1]);
        if (i < 0) return error_setInpError(ERR_NAME, tok[1]);
        j = project_findObject(TIMEPATTERN, tok[2]);
        if (j < 0) return error_setInpError(ERR_NAME, tok[2]);
        Subcatch[i].dStorePattern = j;
        return 0;
    }

    if (match(tok[0], "INFIL"))
    {
        if (ntoks < 3) return error_setInpError(ERR_ITEMS, "");
        i = project_findObject(SUBCATCH, tok[1]);
        if (i < 0) return error_setInpError(ERR_NAME, tok[1]);
        j = project_findObject(TIMEPATTERN, tok[2]);
        if (j < 0) return error_setInpError(ERR_NAME, tok[2]);
        Subcatch[i].infilPattern = j;
        return 0;
    }
////
    return error_setInpError(ERR_KEYWORD, tok[0]);
}

//=============================================================================

function climate_validate()
//
//  Input:   none
//  Output:  none
//  Purpose: validates climatological variables
//
{
    let       i;
    let    a, z, pa;

    // --- check if climate data comes from external data file 
    if ( Wind.type == FILE_WIND || Evap.type == FILE_EVAP ||
         Evap.type == TEMPERATURE_EVAP )
    {
        if ( Fclimate.mode == NO_FILE )
        {
            report_writeErrorMsg(ERR_NO_CLIMATE_FILE, "");
        }
    }

    // --- open the climate data file
    if ( Fclimate.mode == USE_FILE ) climate_openFile();

    // --- snow melt parameters tipm & rnm must be fractions
    if ( Snow.tipm < 0.0 ||
         Snow.tipm > 1.0 ||
         Snow.rnm  < 0.0 ||
         Snow.rnm  > 1.0 ) report_writeErrorMsg(ERR_SNOWMELT_PARAMS, "");

    // --- latitude should be between -90 & 90 degrees
    a = Temp.anglat;
    if ( a <= -89.99 ||
         a >= 89.99  ) report_writeErrorMsg(ERR_SNOWMELT_PARAMS, "");
    else Temp.tanAnglat = Math.tan(a * PI / 180.0);

    // --- compute psychrometric constant
    z = Temp.elev / 1000.0;
    if ( z <= 0.0 ) pa = 29.9;
    else  pa = 29.9 - 1.02*z + 0.0032*Math.pow(z, 2.4); // atmos. pressure
    Temp.gamma = 0.000359 * pa;

    // --- convert units of monthly temperature & evap adjustments
    for (i = 0; i < 12; i++)
    {
        if (UnitSystem == SI) Adjust.temp[i] *= 9.0/5.0;
        Adjust.evap[i] /= UCF(EVAPRATE);
    }
}

//=============================================================================

function climate_openFile()
//
//  Input:   none
//  Output:  none
//  Purpose: opens a climate file and reads in first set of values.
//
{
    let i, m, y;
    let returnObj;

    // --- open the file
    if ( (Fclimate.file = fopen(Fclimate.name, "rt")) == null )
    {
        report_writeErrorMsg(ERR_CLIMATE_FILE_OPEN, Fclimate.name);
        return;
    }

    // --- initialize values of file's climate variables
    //     (Temp.ta was previously initialized in project.c)
    FileValue[TMIN] = Temp.ta;
    FileValue[TMAX] = Temp.ta;
    FileValue[EVAP] = 0.0;
    FileValue[WIND] = 0.0;

    // --- find climate file's format
    FileFormat = getFileFormat();
    if ( FileFormat == UNKNOWN_FORMAT )
    {
        report_writeErrorMsg(ERR_CLIMATE_FILE_READ, Fclimate.name);
        return;
    }

    // --- position file to begin reading climate file at either user-specified
    //     month/year or at start of simulation period.
    rewind(Fclimate.file);
    strcpy(FileLine, "");
    if ( Temp.fileStartDate == NO_DATE ){
        //datetime_decodeDate(StartDate, FileYear, FileMonth, FileDay);
        ////////////////////////////////////
        returnObj = {year: FileYear, month: FileMonth, day: FileDay}
        datetime_decodeDate(StartDate, returnObj);
        FileYear = returnObj.year;
        FileMonth = returnObj.month;
        FileDay = returnObj.day;
        ////////////////////////////////////
    }
    else{
        //datetime_decodeDate(Temp.fileStartDate, FileYear, FileMonth, FileDay);
        ////////////////////////////////////
        returnObj = {year: FileYear, month: FileMonth, day: FileDay}
        datetime_decodeDate(Temp.fileStartDate, returnObj);
        FileYear = returnObj.year;
        FileMonth = returnObj.month;
        FileDay = returnObj.day;
        ////////////////////////////////////
    }
    while ( !feof(Fclimate.file) )
    {
        strcpy(FileLine, "");
        readFileLine(y, m);
        if ( y == FileYear && m == FileMonth ) break;
    }
    if ( feof(Fclimate.file) )
    {
        report_writeErrorMsg(ERR_CLIMATE_END_OF_FILE, Fclimate.name);
        return;
    }

    // --- initialize file dates and current climate variable values
    if ( !ErrorCode )
    {
        FileElapsedDays = 0;
        FileLastDay = datetime_daysPerMonth(FileYear, FileMonth);
        readFileValues();
        for (i=TMIN; i<=WIND; i++)
        {
            if ( FileData[i][FileDay] == MISSING ) continue;
            FileValue[i] = FileData[i][FileDay];
        }
    }
}

//=============================================================================

function climate_initState()
//
//  Input:   none
//  Output:  none
//  Purpose: initializes climate state variables.
//
{
    LastDay = NO_DATE;
    Temp.tmax = MISSING;
    Snow.removed = 0.0;
    NextEvapDate = StartDate;
    NextEvapRate = 0.0;

    // ret facil
    let returnObj;
    let returnVal;

    // --- initialize variables for time series evaporation
    if ( Evap.type == TIMESERIES_EVAP && Evap.tSeries >= 0  )
    {
        // --- initialize NextEvapDate & NextEvapRate to first entry of
        //     time series whose date <= the simulation start date
        ////////////////////////////////////
        returnObj = {x: NextEvapDate, y: NextEvapRate}
        returnVal = table_getFirstEntry(Tseries[Evap.tSeries], returnObj)
        NextEvapDate = returnObj.x;
        NextEvapRate = returnObj.y;
        ////////////////////////////////////
        //table_getFirstEntry(Tseries[Evap.tSeries],
        //                    NextEvapDate, NextEvapRate);
        if ( NextEvapDate < StartDate )
        {  
            setNextEvapDate(StartDate);
        }
        Evap.rate = NextEvapRate / UCF(EVAPRATE);

        // --- find the next time evaporation rates change after this
        setNextEvapDate(NextEvapDate); 
    }

    // --- initialize variables for temperature evaporation
    if ( Evap.type == TEMPERATURE_EVAP )
    {
        Tma.maxCount = sizeof(Tma.ta) / sizeof(double);
        Tma.count = 0;
        Tma.front = 0;
        Tma.tAve = 0.0;
        Tma.tRng = 0.0;
    }
}

//=============================================================================
// DateTime theDate
function climate_setState(theDate)
//
//  Input:   theDate = simulation date
//  Output:  none
//  Purpose: sets climate variables for current date.
//
{
    if ( Fclimate.mode == USE_FILE ) updateFileValues(theDate);
    if ( Temp.dataSource != NO_TEMP ) setTemp(theDate);
    setEvap(theDate);
    setWind(theDate);
    Adjust.rainFactor = Adjust.rain[datetime_monthOfYear(theDate)-1];
    Adjust.hydconFactor = Adjust.hydcon[datetime_monthOfYear(theDate)-1];
    setNextEvapDate(theDate);
}

//=============================================================================

function climate_getNextEvapDate()
//
//  Input:   none
//  Output:  returns the current value of NextEvapDate
//  Purpose: gets the next date when evaporation rate changes.
//
{
    return NextEvapDate;
}

//=============================================================================
// DateTime theDate
function setNextEvapDate(theDate)
//
//  Input:   theDate = current simulation date
//  Output:  sets a new value for NextEvapDate
//  Purpose: finds date for next change in evaporation after the current date.
//
{
    let    yr, mon, day, k;
    let d, e;

    // ret facil
    let returnObj;
    let returnVal;

    // --- do nothing if current date hasn't reached the current next date
    if ( NextEvapDate > theDate ) return;

    switch ( Evap.type )
    {
      // --- for constant evaporation, use a next date far in the future
      case CONSTANT_EVAP:
         NextEvapDate = theDate + 365.;
         break;

      // --- for monthly evaporation, use the start of the next month
      case MONTHLY_EVAP:
        //datetime_decodeDate(theDate, yr, mon, day);
        ////////////////////////////////////
        let returnObj = {year: yr, month: mon, day: day}
        datetime_decodeDate(theDate, returnObj);
        yr = returnObj.year;
        mon = returnObj.month;
        day = returnObj.day;
        ////////////////////////////////////
        if ( mon == 12 )
        {
            mon = 1;
            yr++;
        }
        else mon++;
        NextEvapDate = datetime_encodeDate(yr, mon, 1);
        break;

      // --- for time series evaporation, find the next entry in the
      //     series on or after the current date
      case TIMESERIES_EVAP:
        k = Evap.tSeries;
        if ( k >= 0 )
        {
            NextEvapDate = theDate + 365.;
            ////////////////////////////////////
            returnObj = {x: d, y: e}
            returnVal = table_getNextEntry(Tseries[k], returnObj)
            d = returnObj.x;
            e = returnObj.y;
            ////////////////////////////////////
            //while ( table_getNextEntry(Tseries[k], d, e) && d <= EndDateTime )
            while( returnVal && d <= EndDateTime )
            {
                if ( d >= theDate )
                {
                    NextEvapDate = d;
                    NextEvapRate = e;
                    break;
                }
                ////////////////////////////////////
                returnObj = {x: d, y: e}
                returnVal = table_getNextEntry(Tseries[k], returnObj)
                d = returnObj.x;
                e = returnObj.y;
                ////////////////////////////////////
            }
        }
        break;

      // --- for climate file daily evaporation, use the next day
      case FILE_EVAP:
        NextEvapDate = floor(theDate) + 1.0;
        break;

      default: NextEvapDate = theDate + 365.;
    }
}

//=============================================================================
// DateTime theDate
function updateFileValues(theDate)
//
//  Input:   theDate = current simulation date
//  Output:  none
//  Purpose: updates daily climate variables for new day or reads in
//           another month worth of values if a new month begins.
//
//  NOTE:    counters FileElapsedDays, FileDay, FileMonth, FileYear and
//           FileLastDay were initialized in climate_openFile().
//
{
    let i;
    let deltaDays;

    // --- see if a new day has begun
    deltaDays = (int)(floor(theDate) - floor(StartDateTime));
    if ( deltaDays > FileElapsedDays )
    {
        // --- advance day counters
        FileElapsedDays++;
        FileDay++;

        // --- see if new month of data needs to be read from file
        if ( FileDay > FileLastDay )
        {
            FileMonth++;
            if ( FileMonth > 12 )
            {
                FileMonth = 1;
                FileYear++;
            }
            readFileValues();
            FileDay = 1;
            FileLastDay = datetime_daysPerMonth(FileYear, FileMonth);
        }

        // --- set climate variables for new day
        for (i=TMIN; i<=WIND; i++)
        {
            // --- no change in current value if its missing
            if ( FileData[i][FileDay] == MISSING ) continue;
            FileValue[i] = FileData[i][FileDay];
        }
    }
}

//=============================================================================
// DateTime theDate
function setTemp(theDate)
//
//  Input:   theDate = simulation date
//  Output:  none
//  Purpose: updates temperatures for new simulation date.
//
{
    let      j;                        // snow data object index
    let      k;                        // time series index
    let      mon;                      // month of year 
    let      day;                      // day of year
    let theDay;                   // calendar day
    let   hour;                     // hour of day
    let   tmp;                      // temporary temperature

    // ret facil
    let returnObj;
    let returnVal;

    // --- see if a new day has started
    mon = datetime_monthOfYear(theDate);
    theDay = floor(theDate);
    if ( theDay > LastDay )
    {
        // --- update min. & max. temps & their time of day
        day = datetime_dayOfYear(theDate);
        if ( Temp.dataSource == FILE_TEMP )
        {
            Tmin = FileValue[TMIN] + Adjust.temp[mon-1];
            Tmax = FileValue[TMAX] + Adjust.temp[mon-1];
            if ( Tmin > Tmax )
            {
                tmp = Tmin;
                Tmin = Tmax;
                Tmax = tmp;
            }
            updateTempTimes(day);
            if ( Evap.type == TEMPERATURE_EVAP )
            {
                updateTempMoveAve(Tmin, Tmax); 
                FileValue[EVAP] = getTempEvap(day, Tma.tAve, Tma.tRng);
            }
        }

        // --- compute snow melt coefficients based on day of year
        Snow.season = sin(0.0172615*(day-81.0));
        for (j=0; j<Nobjects[SNOWMELT]; j++)
        {
            snow_setMeltCoeffs(j, Snow.season);
        }

        // --- update date of last day analyzed
        LastDay = theDate;
    }

    // --- for min/max daily temps. from climate file,
    //     compute hourly temp. by sinusoidal interp.
    if ( Temp.dataSource == FILE_TEMP )
    {
        hour = (theDate - theDay) * 24.0;
        if ( hour < Hrsr )
            Temp.ta = Tmin + Trng1/2.0 * sin(PI/Dydif * (Hrsr - hour));
        else if ( hour >= Hrsr && hour <= Hrss )
            Temp.ta = Tave + Trng * sin(PI/Dhrdy * (Hrday - hour));
        else
            Temp.ta = Tmax - Trng * sin(PI/Dydif * (hour - Hrss));
    }

    // --- for user-supplied temperature time series,
    //     get temperature value from time series
    if ( Temp.dataSource == TSERIES_TEMP )
    {
        k = Temp.tSeries;
        if ( k >= 0)
        {
            ////////////////////////////////////
            returnObj = {table: Tseries[k]}
            returnVal = table_tseriesLookup(returnObj, theDate, true);
            Tseries[k] = returnObj.table;
            ////////////////////////////////////
            Temp.ta = returnVal;
            //Temp.ta = table_tseriesLookup(Tseries[k], theDate, true);

            // --- convert from deg. C to deg. F if need be
            if ( UnitSystem == SI )
            {
                Temp.ta = (9./5.) * Temp.ta + 32.0;
            }

            // --- apply climate change adjustment factor 
            Temp.ta += Adjust.temp[mon-1];
        }
    }

    // --- compute saturation vapor pressure
    Temp.ea = 8.1175e6 * exp(-7701.544 / (Temp.ta + 405.0265) );
}

//=============================================================================
// DateTime theDate
function setEvap(theDate)
//
//  Input:   theDate = simulation date
//  Output:  none
//  Purpose: sets evaporation rate (ft/sec) for a specified date.
//
{
    let k;
    let mon = datetime_monthOfYear(theDate);

    switch ( Evap.type )
    {
      case CONSTANT_EVAP:
        Evap.rate = Evap.monthlyEvap[0] / UCF(EVAPRATE);
        break;

      case MONTHLY_EVAP:
        Evap.rate = Evap.monthlyEvap[mon-1] / UCF(EVAPRATE);
        break;

      case TIMESERIES_EVAP:
        if ( theDate >= NextEvapDate )
            Evap.rate = NextEvapRate / UCF(EVAPRATE);
        break;

      case FILE_EVAP:
        Evap.rate = FileValue[EVAP] / UCF(EVAPRATE);
        Evap.rate *= Evap.panCoeff[mon-1];
        break;

      case TEMPERATURE_EVAP:
        Evap.rate = FileValue[EVAP] / UCF(EVAPRATE);
        break;

      default: Evap.rate = 0.0;
    }

    // --- apply climate change adjustment
    Evap.rate += Adjust.evap[mon-1];

    // --- set soil recovery factor
    Evap.recoveryFactor = 1.0;
    k = Evap.recoveryPattern;
    if ( k >= 0 && Pattern[k].type == MONTHLY_PATTERN )
    {
        Evap.recoveryFactor = Pattern[k].factor[mon-1];
    }
}

//=============================================================================
// DateTime theDate
function setWind(theDate)
//
//  Input:   theDate = simulation date
//  Output:  none
//  Purpose: sets wind speed (mph) for a specified date.
//
{
    let yr, mon, day;

    switch ( Wind.type )
    {
      case MONTHLY_WIND:
        //datetime_decodeDate(theDate, yr, mon, day);
        ////////////////////////////////////
        let returnObj = {year: yr, month: mon, day: day}
        datetime_decodeDate(theDate, returnObj);
        yr = returnObj.year;
        mon = returnObj.month;
        day = returnObj.day;
        ////////////////////////////////////
        Wind.ws = Wind.aws[mon-1] / UCF(WINDSPEED);
        break;

      case FILE_WIND:
        Wind.ws = FileValue[WIND];
        break;

      default: Wind.ws = 0.0;
    }
}

//=============================================================================
// int day
function updateTempTimes(day)
//
//  Input:   day = day of year
//  Output:  none
//  Purpose: computes time of day when min/max temperatures occur.
//           (min. temp occurs at sunrise, max. temp. at 3 hrs. < sunset)
//
{
    let decl;                       // earth's declination
    let hrang;                      // hour angle of sunrise/sunset
    let arg;

    decl  = 0.40928*cos(0.017202*(172.0-day));
    arg = -tan(decl)*Temp.tanAnglat;
    if      ( arg <= -1.0 ) arg = PI;
    else if ( arg >= 1.0 )  arg = 0.0;
    else                    arg = acos(arg);
    hrang = 3.8197 * arg;
    Hrsr  = 12.0 - hrang + Temp.dtlong;
    Hrss  = 12.0 + hrang + Temp.dtlong - 3.0;
    Dhrdy = Hrsr - Hrss;
    Dydif = 24.0 + Hrsr - Hrss;
    Hrday = (Hrsr + Hrss) / 2.0;
    Tave  = (Tmin + Tmax) / 2.0;
    Trng  = (Tmax - Tmin) / 2.0;
    if ( Temp.tmax == MISSING ) Trng1 = Tmax - Tmin;
    else                        Trng1 = Temp.tmax - Tmin;
    Temp.tmax = Tmax;
}

//=============================================================================
// int day, double tave, double trng
function getTempEvap(day, tave, trng)
//
//  Input:   day = day of year
//           tave = 7-day average temperature (deg F)
//           trng = 7-day average daily temperature range (deg F)
//  Output:  returns evaporation rate in user's units (US:in/day, SI:mm/day)
//  Purpose: uses Hargreaves method to compute daily evaporation rate
//           from daily average temperatures and Julian day.
//
{
    let a = 2.0*PI/365.0;
    let ta = (tave - 32.0)*5.0/9.0;           //average temperature (deg C)
    let tr = trng*5.0/9.0;                    //temperature range (deg C)
    let lamda = 2.50 - 0.002361 * ta;         //latent heat of vaporization
    let dr = 1.0 + 0.033*cos(a*day);          //relative earth-sun distance
    let phi = Temp.anglat*2.0*PI/360.0;       //latitude angle (rad)
    let del = 0.4093*sin(a*(284+day));        //solar declination angle (rad)
    let omega = acos(-tan(phi)*tan(del));     //sunset hour angle (rad)
    let ra = 37.6*dr*                         //extraterrestrial radiation
                (omega*sin(phi)*sin(del) +
                 cos(phi)*cos(del)*sin(omega));
    let e = 0.0023*ra/lamda*sqrt(tr)*(ta+17.8);    //evap. rate (mm/day)
    if ( e < 0.0 ) e = 0.0;
    if ( UnitSystem == US ) e /= MMperINCH;           //evap rate (in/day)
    return e;
}

//=============================================================================

function  getFileFormat()
//
//  Input:   none
//  Output:  returns code number of climate file's format
//  Purpose: determines what format the climate file is in.
//
{
    let recdType = "";
    let elemType = ""; //size 4
    let filler = "";   // size 5
    let staID;        // size 80
    let s;            // size 80
    let line;    // size MAXLINE

    let  y, m, d, n;

    // --- read first line of file
    if ( fgets(line, MAXLINE, Fclimate.file) == null ) return UNKNOWN_FORMAT;

    // --- check for TD3200 format
    sstrncpy(recdType, line, 3);
    sstrncpy(filler, line[23], 4);
    if ( strcmp(recdType, "DLY") == 0 &&
         strcmp(filler, "9999")  == 0 ) return TD3200;

    // --- check for DLY0204 format
    if ( line.length >= 233 )
    {
        sstrncpy(elemType, line[13], 3);
        n = parseInt(elemType);
        if ( n == 1 || n == 2 || n == 151 ) return DLY0204;
    }

    // --- check for USER_PREPARED format
    n = sscanf(line, "%s %d %d %d %s", staID, y, m, d, s);
    if ( n == 5 ) return USER_PREPARED;

    // --- check for GHCND format
    if ( isGhcndFormat(line) ) return GHCND;

    return UNKNOWN_FORMAT;
}

//=============================================================================
//int *y, int *m
function readFileLine(y, m)
//
//  Input:   none
//  Output:  y = year
//           m = month
//  Purpose: reads year & month from next line of climate file.
//
{
    // --- read next line from climate data file
    while ( FileLine.length == 0 )
    {
        if ( fgets(FileLine, MAXLINE, Fclimate.file) == null ) return;
     	if ( FileLine[0] == '\n' ) FileLine[0] = '\0';
    }

    // --- parse year & month from line
    switch (FileFormat)
    {
    case  USER_PREPARED: readUserFileLine(y, m);   break;
    case  TD3200:        readTD3200FileLine(y,m);  break;
    case  DLY0204:       readDLY0204FileLine(y,m); break;
    case  GHCND:         readGhcndFileLine(y,m);   break; 
    }
}

//=============================================================================
// int* y, int* m
function readUserFileLine(y, m)
//
//  Input:   none
//  Output:  y = year
//           m = month
//  Purpose: reads year & month from line of User-Prepared climate file.
//
{
    let n;
    let staID;
    n = sscanf(FileLine, "%s %d %d", staID, y, m);
    if ( n < 3 )
    {
        report_writeErrorMsg(ERR_CLIMATE_FILE_READ, Fclimate.name);
    }
}

//=============================================================================
// int* y, int* m
function readTD3200FileLine(y, m)
//
//  Input:   none
//  Output:  y = year
//           m = month
//  Purpose: reads year & month from line of TD-3200 climate file.
//
{
    let recdType = ""; //[4]
    let year = ""; //[5]
    let month = ""; //[3]
    let  len;

    // --- check for minimum number of characters
    len = FileLine.length;
    if ( len < 30 )
    {
        report_writeErrorMsg(ERR_CLIMATE_FILE_READ, Fclimate.name);
        return;
    }

    // --- check for proper type of record
    sstrncpy(recdType, FileLine, 3);
    if ( strcmp(recdType, "DLY") != 0 )
    {
        report_writeErrorMsg(ERR_CLIMATE_FILE_READ, Fclimate.name);
        return;
    }

    // --- get record's date
    sstrncpy(year,  FileLine[17], 4);
    sstrncpy(month, FileLine[21], 2);
    y = parseInt(year);
    m = parseInt(month);
}

//=============================================================================
// int* y, int* m
function readDLY0204FileLine(y, m)
//
//  Input:   none
//  Output:  y = year
//           m = month
//  Purpose: reads year & month from line of DLY02 or DLY04 climate file.
//
{
    let year = ""; //[5]
    let month = ""; //[3]
    let  len;

    // --- check for minimum number of characters
    len = FileLine.length;
    if ( len < 16 )
    {
        report_writeErrorMsg(ERR_CLIMATE_FILE_READ, Fclimate.name);
        return;
    }

    // --- get record's date
    sstrncpy(year,  FileLine[7], 4);
    sstrncpy(month, FileLine[11], 2);
    y = parseInt(year);
    m = parseInt(month);
}

//=============================================================================

function readFileValues()
//
//  Input:   none
//  Output:  none
//  Purpose: reads next month's worth of data from climate file.
//
{
    let  i, j;
    let  y, m;

    // --- initialize FileData array to missing values
    for ( i=0; i<MAXCLIMATEVARS; i++)
    {
        for (j=0; j<MAXDAYSPERMONTH; j++) FileData[i][j] = MISSING;
    }

    while ( !ErrorCode )
    {
        // --- return when date on line is after current file date
        if ( feof(Fclimate.file) ) return;
        readFileLine(y, m);
        if ( y > FileYear || m > FileMonth ) return;

        // --- parse climate values from file line
        switch (FileFormat)
        {
        case  USER_PREPARED: parseUserFileLine();   break;
        case  TD3200:        parseTD3200FileLine();  break;
        case  DLY0204:       parseDLY0204FileLine(); break;
        case  GHCND:         parseGhcndFileLine();   break; 
        }
        strcpy(FileLine, "");
    }
}

//=============================================================================

function parseUserFileLine()
//
//  Input:   none
//  Output:  none
//  Purpose: parses climate variable values from a line of a user-prepared
//           climate file.
//
{
    let   n;
    let   y, m, d;
    let  staID//[80];
    let  s0//[80];
    let  s1//[80];
    let  s2//[80];
    let  s3//[80];
    let x;

    // --- read day, Tmax, Tmin, Evap, & Wind from file line
    n = sscanf(FileLine, "%s %d %d %d %s %s %s %s",
        staID, y, m, d, s0, s1, s2, s3);
    if ( n < 4 ) return;
    if ( d < 1 || d > 31 ) return;

    // --- process TMAX
    if ( s0.length > 0 && s0 != '*' )
    {
        x = atof(s0);
        if ( UnitSystem == SI ) x = 9./5.*x + 32.0;
        FileData[TMAX][d] =  x;
    }

    // --- process TMIN
    if ( s1.length > 0 && s1 != '*' )
    {
        x = atof(s1);
        if ( UnitSystem == SI ) x = 9./5.*x + 32.0;
        FileData[TMIN][d] =  x;
    }

    // --- process EVAP
    if ( s2.length > 0 && s2 != '*' ) FileData[EVAP][d] = atof(s2);

    // --- process WIND
    if ( s3.length > 0 && s3 != '*' ) FileData[WIND][d] = atof(s3);
}

//=============================================================================

function parseTD3200FileLine()
//
//  Input:   none
//  Output:  none
//  Purpose: parses climate variable values from a line of a TD3200 file.
//
{
    let  i;
    let param = "";// [5]

    // --- parse parameter name
    sstrncpy(param, FileLine[11], 4);

    // --- see if parameter is temperature, evaporation or wind speed
    for (i=0; i<MAXCLIMATEVARS; i++)
    {
        if (strcmp(param, ClimateVarWords[i]) == 0 ) setTD3200FileValues(i);
    }
}

//=============================================================================
//int i
function setTD3200FileValues(i)
//
//  Input:   i = climate variable code
//  Output:  none
//  Purpose: reads month worth of values for climate variable from TD-3200 file.
//
{
    let valCount = "";//[4]
    let day = "";//[3]
    let sign = "";//[2]
    let value = "";//[6]
    let flag2 = "";//[2]
    let x;
    let  nValues;
    let  j, k, d;
    let  lineLength;

    // --- parse number of days with data from cols. 27-29 of file line
    //sstrncpy(valCount, FileLine[27], 3);
    valCount = FileLine.slice(27, 30)
    nValues = parseInt(valCount);
    lineLength = FileLine.length;

    // --- check for enough characters on line
    if ( lineLength >= 12*nValues + 30 )
    {
        // --- for each day's value
        for (j=0; j<nValues; j++)
        {
            // --- parse day, value & flag from file line
            k = 30 + j*12;
            //sstrncpy(day,   &FileLine[k], 2);
            //sstrncpy(sign,  &FileLine[k+4], 1);
            //sstrncpy(value, &FileLine[k+5], 5);
            //sstrncpy(flag2, &FileLine[k+11], 1);
            day = FileLine.slice(k, k+2)
            sign = FileLine.slice(k+4, k+1)
            value = FileLine.slice(k, k+5)
            flag2 = FileLine.slice(k, k+1)

            // --- if value is valid then store it in FileData array
            d = parseInt(day);
            if ( value != "99999"
                 && ( flag2[0] == '0' || flag2[0] == '1')
                 &&   d > 0
                 &&   d <= 31 )
            {
                // --- convert from string value to numerical value
                x = parseFloat(value);
                if ( sign[0] == '-' ) x = -x;

                // --- convert evaporation from hundreths of inches
                if ( i == EVAP )
                {
                    x /= 100.0;

                    // --- convert to mm if using SI units
                    if ( UnitSystem == SI ) x *= MMperINCH;
                }

                // --- convert wind speed from miles/day to miles/hour
                if ( i == WIND ) x /= 24.0;

                // --- store value
                FileData[i][d] = x;
            }
        }
    }
}

//=============================================================================

function parseDLY0204FileLine()
//
//  Input:   none
//  Output:  none
//  Purpose: parses a month's worth of climate variable values from a line of
//           a DLY02 or DLY04 climate file.
//
{
    let  j, k, p;
    let param = "";//[4]
    let sign  = "";//[2]
    let value = "";//[6]
    let code  = "";//[2]
    let x;

    // --- parse parameter name
    param =  FileLine.slice(13, 16);

    // --- see if parameter is min or max temperature
    p = parseInt(param);
    if ( p == 1 ) p = TMAX;
    else if ( p == 2 ) p = TMIN;
    else if ( p == 151 ) p = EVAP;
    else return;

    // --- check for 233 characters on line
    if ( FileLine.length < 233 ) return;

    // --- for each of 31 days
    k = 16;
    for (j=1; j<=31; j++)
    {
        // --- parse value & flag from file line
        sign =  FileLine.slice(k, k+1);
        value = FileLine.slice(k+1, k+6);
        code =  FileLine.slice(k+6, k+7);
        k += 7;

        // --- if value is valid then store it in FileData array

        if ( strcmp(value, "99999") != 0 && strcmp(value, "     ") != 0 )
        {
            switch (p)
            {
            case TMAX:
            case TMIN:
                // --- convert from integer tenths of a degree C to degrees F
                x = atof(value) / 10.0;
                if ( sign[0] == '-' ) x = -x;
                x = 9./5.*x + 32.0;
                break;
            case EVAP:
                // --- convert from 0.1 mm to inches or mm
                x = atof(value) / 10.0;
                if ( UnitSystem == US ) x /= MMperINCH;
                break;
			default: return;
            }
            FileData[p][j] = x;
        }
    }
}

//=============================================================================
//char* line
function isGhcndFormat(line)
//
//  Input:   line = first line of text from a climate file
//  Output:  returns TRUE if climate file is in NCDC GHCN Daily format.
//  Purpose: Checks if a climate file is in the NCDC GHCN Daily format
//           and determines the position of each climate variable field.
//
{
    let i;
    let ptr;

    // --- find starting position of the DATE field
    ptr = strstr(line, "DATE");
    if ( ptr == null ) return FALSE;
    FileDateFieldPos = ptr - line;

    // --- initialize starting position of each data field
    for ( i = TMIN; i <= WIND; i++) FileFieldPos[i] = -1;

    // --- find starting position of each climate variable's data field
    ptr = strstr(line, "TMIN");
    if ( ptr ) FileFieldPos[TMIN] = ptr - line;
    ptr = strstr(line, "TMAX");
    if ( ptr ) FileFieldPos[TMAX] = ptr - line;
    ptr = strstr(line, "EVAP");
    if ( ptr ) FileFieldPos[EVAP] = ptr - line;

    // --- WIND can either be daily movement or average speed
    FileWindType = WDMV;
    ptr = strstr(line, "WDMV");
    if ( ptr == null )
    {
        FileWindType = AWND;
        ptr = strstr(line, "AWND");
    }
    if ( ptr ) FileFieldPos[WIND] = ptr - line;

    // --- check if at least one climate variable was found
    for (i = TMIN; i <= WIND; i++) if (FileFieldPos[i] >= 0 ) return TRUE;
    return FALSE;
}

//=============================================================================
// int* y, int* m
function readGhcndFileLine(y, m)
//
//  Input:   none
//  Output:  y = year
//           m = month
//  Purpose: reads year & month from line of a NCDC GHCN Daily climate file.
//
{
    let n = sscanf(FileLine[FileDateFieldPos], "%4d%2d", y, m);
    if ( n != 2 )
    {
        y = -99999;
        m = -99999;
    }
}

//=============================================================================

function parseGhcndFileLine()
//
//  Input:   none
//  Output:  none
//  Purpose: parses a line of a NCDC GHCN Daily file for daily
//           values of max/min temperature, pan evaporation and
//           wind speed.
//
{
    let y, m, d, n, v;
    let x;

    // --- parse day of month from date field
    n = sscanf(FileLine[FileDateFieldPos], "%4d%2d%2d", y, m, d);
    if ( n < 3 ) return;
    if ( d < 1 || d > 31 ) return;

    // --- parse temperatures (in tenths of deg. C) to deg F
    if ( FileFieldPos[TMAX] >= 0 )
    {
        if ( sscanf(FileLine[FileFieldPos[TMAX]], "%8d", v) > 0 )
        {
            if ( abs(v) < 9999 )
                FileData[TMAX][d] = v*0.1*9.0/5.0 + 32.0;
        }
    }
    if ( FileFieldPos[TMIN] >= 0 )
    {
        if ( sscanf(FileLine[FileFieldPos[TMIN]], "%8d", v) > 0 )
        {
            if ( abs(v) < 9999 )
                FileData[TMIN][d] = v*0.1*9.0/5.0 + 32.0;
        }
    }

    // -- parse evaporation (in tenths of mm) to user units
    if ( FileFieldPos[EVAP] >= 0 )
    {
        if ( sscanf(FileLine[FileFieldPos[EVAP]], "%8d", v) > 0 )
        {
            if ( abs(v) < 9999 )
            {
                x = v * 0.1;
                if ( UnitSystem == US ) x /= MMperINCH;
                FileData[EVAP][d] = x;
            }
        }
    }

    // --- parse wind speed (in km/day for WDMV or tenths of m/s for AWND)
    //     to miles/hr
    if ( FileFieldPos[WIND] >= 0 )
    {
        if ( sscanf(FileLine[FileFieldPos[WIND]], "%8d", v) > 0 )
        {
            if ( abs(v) < 9999 )
            {
                if ( FileWindType == WDMV ) x = v * 0.62137 / 24.;
                else x = v * 0.1 / 1000. * 0.62137 * 3600.;
                FileData[WIND][d] = x;
            }
        }
    }
}

//=============================================================================
//double tmin, double tmax
function updateTempMoveAve(tmin, tmax)
//
//  Input:   tmin = minimum daily temperature (deg F)
//           tmax = maximum daily temperature (deg F)
//  Output:  none
//  Purpose: updates moving averages of average daily temperature
//           and daily temperature range stored in structure Tma.
//
{
    let ta,               // new day's average temperature (deg F)
           tr;               // new day's temperature range (deg F)
    let    count = Tma.count;

    // --- find ta and tr from new day's min and max temperature
    ta = (tmin + tmax) / 2.0;
    tr = Math.abs(tmax - tmin);

    // --- if the array used to store previous days' temperatures is full
    if ( count == Tma.maxCount )
    {
        // --- update the moving averages with the new day's value
        Tma.tAve = (Tma.tAve * count + ta - Tma.ta[Tma.front]) / count;
        Tma.tRng = (Tma.tRng * count + tr - Tma.tr[Tma.front]) / count;

        // --- replace the values at the front of the moving average window
        Tma.ta[Tma.front] = ta;
        Tma.tr[Tma.front] = tr;

        // --- move the front one position forward
        Tma.front++;
        if ( Tma.front == count ) Tma.front = 0;
    }

    // --- array of previous day's values not full (at start of simulation)
    else
    {
        // --- find new moving averages by adding new values to previous ones
        Tma.tAve = (Tma.tAve * count + ta) / (count + 1);
        Tma.tRng = (Tma.tRng * count + tr) / (count + 1);

        // --- save new day's values
        Tma.ta[Tma.front] = ta;
        Tma.tr[Tma.front] = tr;

        // --- increment count and front of moving average window
        Tma.count++;
        Tma.front++;
        if ( Tma.count == Tma.maxCount ) Tma.front = 0;
    }
}