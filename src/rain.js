//-----------------------------------------------------------------------------
//   rain.c
//
//   Project: EPA SWMM5
//   Version: 5.1
//   Date:    03/20/14  (Build 5.1.001)
//            08/05/15  (Build 5.1.010)
//            08/22/16  (Build 5.1.011)
//            05/10/18  (Build 5.1.013)
//            03/01/20  (Build 5.1.014)
//   Author:  L. Rossman
//
//   Places rainfall data from external files into a SWMM rainfall
//   interface file.
//
//   The following types of external data files are supported:
//   NWS_TAPE:            NCDC NWS TD 3240 or 3260 data in fixed field widths
//   NWS_SPACE_DELIMITED: NCDC NWS TD (DSI) 3240 or 3260 data in space delimited
//                        format, with or without header lines, with or without
//                        station name
//   NWS_COMMA_DELIMITED: NCDC NWS TD (DSI) 3240 or 3260 data in comma delimited
//                        format, with or without header lines
//   NWS_ONLINE_60:       NCDC NWS hourly space delimited online format
//   NWS_ONLINE_15:       NCDC NWS fifteen minute space delimited online format
//   AES_HLY:             Canadian AES hourly data with 3-digit year
//   CMC_HLY:             Canadian CMC hourly data in HLY03 or HLY21 format
//   CMC_FIF:             Canadian CMC fifteen minute data in in FIF21 format
//   STD_SPACE_DELIMITED: standard SWMM space delimted format:
//                        StaID  Year  Month  Day  Hour  Minute  Rainfall
//
//   The layout of the SWMM binary rainfall interface file is:
//     File stamp ("SWMM5-RAIN") (10 bytes)
//     Number of SWMM rain gages in file (4-byte int)
//     Repeated for each rain gage:
//       recording station ID (not SWMM rain gage ID) (MAXMSG+1 (=80) bytes)
//       gage recording interval (seconds) (4-byte int)
//       starting byte of rain data in file (4-byte int)
//       ending byte+1 of rain data in file (4-byte int)
//     For each gage:
//       For each time period with non-zero rain:
//         Date/time for start of period (8-byte double)
//         Rain depth (inches) (4-byte float)
//
//   Release 5.1.010:
//   - Modified error message for records out of sequence in std. format file.
//
//   Release 5.1.011:
//   - Can now read decimal rainfall values in newer NWS online format.
//
//   Release 5.1.013:
//   - Variable x properly initialized with float value in readNwsOnlineValue().
//
//   Release 5.1.014:
//   - Fixed indexing bug in rainFileConflict() function.
//-----------------------------------------------------------------------------

//-----------------------------------------------------------------------------
//  Constants
//-----------------------------------------------------------------------------
//enum RainFileFormat {
var UNKNOWN_FORMAT = 0 
var NWS_TAPE       = 1
var NWS_SPACE_DELIMITED = 2
var NWS_COMMA_DELIMITED = 3
var NWS_ONLINE_60 = 4
var NWS_ONLINE_15 = 5
var AES_HLY = 6 
var CMC_HLY = 7
var CMC_FIF = 8
var STD_SPACE_DELIMITED = 9


//enum ConditionCodes {
var NO_CONDITION = 0 
var ACCUMULATED_PERIOD = 1 
var DELETED_PERIOD = 2
var MISSING_PERIOD = 3

//-----------------------------------------------------------------------------
//  Shared variables
//-----------------------------------------------------------------------------
var RainStats = new TRainStats();      // TRainStats              // see objects.h for definition
var        Condition;                  // rainfall condition code
var        TimeOffset;                 // time offset of rainfall reading (sec)
var        DataOffset;                 // start of data on line of input
var        ValueOffset;                // start of rain value on input line
var        RainType;                   // rain measurement type code
var        Interval;                   // rain measurement interval (sec)
var        UnitsFactor;                // units conversion factor
var        RainAccum;                  // rainfall depth accumulation
var        StationID;                  // station ID appearing in rain file
var        AccumStartDate;             // date when accumulation begins
var        PreviousDate;               // date of previous rainfall record
var        GageIndex;                  // index of rain gage analyzed
var        hasStationName;             // true if data contains station name

//-----------------------------------------------------------------------------
//  External functions (declared in funcs.h)
//-----------------------------------------------------------------------------
//  rain_open   (called by swmm_start in swmm5.c)
//  rain_close  (called by swmm_end in swmm5.c)

//=============================================================================
// void
function  rain_open()
//
//  Input:   none
//  Output:  none
//  Purpose: opens binary rain interface file and RDII processor.
//
{
    let i;
    let count;

    // --- see how many gages get their data from a file
    count = 0;
    for (i = 0; i < Nobjects[GAGE]; i++)
    {
        if ( Gage[i].dataSource == RAIN_FILE ) count++;
    }
    Frain.file = null;
    if ( count == 0 )
    {
        Frain.mode = NO_FILE;
    }

    // --- see what kind of rain interface file to open
    else switch ( Frain.mode )
    {
      case SCRATCH_FILE:
        getTempFileName(Frain.name);
        if ( (Frain.file = fopen(Frain.name, "w+b")) == null)
        {
            report_writeErrorMsg(ERR_RAIN_FILE_SCRATCH, "");
            return;
        }
        break;

      case USE_FILE:
        if ( (Frain.file = fopen(Frain.name, "r+b")) == null)
        {
            report_writeErrorMsg(ERR_RAIN_FILE_OPEN, Frain.name);
            return;
        }
        break;

      case SAVE_FILE:
        if ( (Frain.file = fopen(Frain.name, "w+b")) == null)
        {
            report_writeErrorMsg(ERR_RAIN_FILE_OPEN, Frain.name);
            return;
        }
        break;
    }

    // --- create new rain file if required
    if ( Frain.mode == SCRATCH_FILE || Frain.mode == SAVE_FILE )
    {
        createRainFile(count);
    }

    // --- initialize rain file
    if ( Frain.mode != NO_FILE ) initRainFile();

    // --- open RDII processor (creates/opens a RDII interface file)
    rdii_openRdii();
}

//=============================================================================
// void
function rain_close()
//
//  Input:   none
//  Output:  none
//  Purpose: closes rain interface file and RDII processor.
//
{
    if ( Frain.file )
    {
        fclose(Frain.file);
        if ( Frain.mode == SCRATCH_FILE ) remove(Frain.name);
    }
    Frain.file = null;
    rdii_closeRdii();
}

//=============================================================================
// int count
function createRainFile(count)
//
//  Input:   count = number of files to include in rain interface file
//  Output:  none
//  Purpose: adds rain data from all rain gage files to the interface file.
//
{
    let   i, k;
    let   kount = count;               // number of gages in data file
    let   filePos1;                    // starting byte of gage's header data
    let   filePos2;                    // starting byte of gage's rain data
    let   filePos3;                    // starting byte of next gage's data
    let   interval;                    // recording interval (sec)
    let   dummy = -1;
    let   staID;             // gage's ID name
    let   fileStamp = "SWMM5-RAIN";

    // --- make sure interface file is open and no error condition
    if ( ErrorCode || !Frain.file ) return;

    // --- write file stamp & # gages to file
    fwrite(fileStamp, sizeof(char), fileStamp.length, Frain.file);
    fwrite(kount, sizeof(int), 1, Frain.file);
    filePos1 = ftell(Frain.file);

    // --- write default fill-in header records to file for each gage
    //     (will be replaced later with actual records)
    if ( count > 0 ) report_writeRainStats(-1, RainStats);
    for ( i = 0;  i < count; i++ )
    {
        fwrite(staID, sizeof(char), MAXMSG+1, Frain.file);
        for ( k = 1; k <= 3; k++ )
            fwrite(dummy, sizeof(int), 1, Frain.file);
    }
    filePos2 = ftell(Frain.file);

    // --- loop through project's  rain gages,
    //     looking for ones using rain files
    for ( i = 0; i < Nobjects[GAGE]; i++ )
    {
        if ( ErrorCode || Gage[i].dataSource != RAIN_FILE ) continue;
        if ( rainFileConflict(i) ) break;

        // --- position rain file to where data for gage will begin
        fseek(Frain.file, filePos2, SEEK_SET);

        // --- add gage's data to rain file
        if ( addGageToRainFile(i) )
        {
            // --- write header records for gage to beginning of rain file
            filePos3 = ftell(Frain.file);
            fseek(Frain.file, filePos1, SEEK_SET);
            sstrncpy(staID, Gage[i].staID, MAXMSG);
            interval = Interval;
            fwrite(staID,      sizeof(char), MAXMSG+1, Frain.file);
            fwrite(interval,  sizeof(int), 1, Frain.file);
            fwrite(filePos2,  sizeof(int), 1, Frain.file);
            fwrite(filePos3,  sizeof(int), 1, Frain.file);
            filePos1 = ftell(Frain.file);
            filePos2 = filePos3;
            report_writeRainStats(i, RainStats);
        }
    }

    // --- if there was an error condition, then delete newly created file
    if ( ErrorCode )
    {
        fclose(Frain.file);
        Frain.file = null;
        remove(Frain.name);
    }
}

//=============================================================================
// int i
function rainFileConflict(i)
//
//  Input:   i = rain gage index
//  Output:  returns 1 if file conflict found, 0 if not
//  Purpose: checks if a rain gage's station ID matches another gage's
//           station ID but the two use different rain data files.
//
{
    let j;
    let staID = Gage[i].staID;
    let fname = Gage[i].fname;
    for (j = 0; j < i; j++)
    {
        if ( strcomp(Gage[j].staID, staID) && !strcomp(Gage[j].fname, fname) )
        {
            report_writeErrorMsg(ERR_RAIN_FILE_CONFLICT, Gage[i].ID);
            return 1;
        }
    }
    return 0;
}

//=============================================================================
// int i
function addGageToRainFile(i)
//
//  Input:   i = rain gage index
//  Output:  returns 1 if successful, 0 if not
//  Purpose: adds a gage's rainfall record to rain interface file
//
{
    //FILE* f;                           // pointer to rain file
    let   f;
    let   fileFormat;                  // file format code
    let   hdrLines;                    // number of header lines skipped

    // --- let StationID point to null
    StationID = null;

    // --- check that rain file exists
    if ( (f = fopen(Gage[i].fname, "rt")) == null )
        report_writeErrorMsg(ERR_RAIN_FILE_DATA, Gage[i].fname);
    else
    {
        fileFormat = findFileFormat(f, i, hdrLines);
        if ( fileFormat == UNKNOWN_FORMAT )
        {
            report_writeErrorMsg(ERR_RAIN_FILE_FORMAT, Gage[i].fname);
        }
        else
        {
            GageIndex = i;
            readFile(f, fileFormat, hdrLines, Gage[i].startFileDate,
                     Gage[i].endFileDate);
        }
        fclose(f);
    }
    if ( ErrorCode ) return 0;
    else
    return 1;
}

//=============================================================================
// void
function initRainFile()
//
//  Input:   none
//  Output:  none
//  Purpose: initializes rain interface file for reading.
//
{
    let  fileStamp = "SWMM5-RAIN";
    let  fStamp = "SWMM5-RAIN";
    let  i;
    let  kount;
    let  filePos;

    // --- make sure interface file is open and no error condition
    if ( ErrorCode || !Frain.file ) return;

    // --- check that interface file contains proper file stamp
    rewind(Frain.file);
    fread(fStamp, sizeof(char), fileStamp.length, Frain.file);
    if ( strcmp(fStamp, fileStamp) != 0 )
    {
        report_writeErrorMsg(ERR_RAIN_IFACE_FORMAT, "");
        return;
    }
    fread(kount, sizeof(int), 1, Frain.file);
    filePos = ftell(Frain.file);

    // --- locate information for each raingage in interface file
    for ( i = 0; i < Nobjects[GAGE]; i++ )
    {
        if ( ErrorCode || Gage[i].dataSource != RAIN_FILE ) continue;

        // --- match station ID for gage with one in file
        fseek(Frain.file, filePos, SEEK_SET);
        if ( !findGageInFile(i, kount) ||
             Gage[i].startFilePos == Gage[i].endFilePos )
        {
            report_writeErrorMsg(ERR_RAIN_FILE_GAGE, Gage[i].ID);
        }
    }
}

//=============================================================================
// int i, int kount
function findGageInFile(i, kount)
//
//  Input:   i     = rain gage index
//           kount = number of rain gages stored on interface file
//  Output:  returns true if successful, false if not
//  Purpose: checks if rain gage's station ID appears in interface file.
//
{
    let  k;
    let  interval;
    let  filePos1, filePos2;
    let  staID;

    for ( k = 1; k <= kount; k++ )
    {
        fread(staID,      sizeof(char), MAXMSG+1, Frain.file);
        fread(interval,  sizeof(int), 1, Frain.file);
        fread(filePos1,  sizeof(int), 1, Frain.file);
        fread(filePos2,  sizeof(int), 1, Frain.file);
        if ( strcmp(staID, Gage[i].staID) == 0 )
        {
            // --- match found; save file parameters
            Gage[i].rainType     = RAINFALL_VOLUME;
            Gage[i].rainInterval = interval;
            Gage[i].startFilePos = filePos1;
            Gage[i].endFilePos   = filePos2;
            Gage[i].currentFilePos = Gage[i].startFilePos;
            return true;
        }
    }
    return false;
}

//=============================================================================
// FILE *f, int i, int *hdrLines
function findFileFormat(f, i, hdrLines)
//
//  Input:   f = ptr. to rain gage's rainfall data file
//           i = rain gage index
//  Output:  hdrLines  = number of header lines found in data file;
//           returns type of format used in a rainfall data file
//  Purpose: finds the format of a gage's rainfall data file.
//
{
    let   fileFormat;
    let   lineCount;
    let   maxCount = 5;
    let   n;
    let   div;
    let  sn2;
    let  recdType;
    let  elemType;
    let  coopID;
    let  line;
    let   year, month, day, hour, minute;
    let   elem;
    let x;

    // --- check first few lines for known formats
    fileFormat = UNKNOWN_FORMAT;
    hasStationName = false;
    UnitsFactor = 1.0;
    Interval = 0;
    hdrLines = 0;
    for (lineCount = 1; lineCount <= maxCount; lineCount++)
    {
        if ( fgets(line, MAXLINE, f) == null ) return fileFormat;

        // --- check for NWS space delimited format
        n = sscanf(line, "%6ld %2d %4s", sn2, div, elemType);
        if ( n == 3 )
        {
            Interval = getNWSInterval(elemType);
            TimeOffset = Interval;
            if ( Interval > 0 )
            {
                fileFormat = NWS_SPACE_DELIMITED;
                break;
            }
        }

        // --- check for NWS space delimited format w/ station name
        n = sscanf(line[37], "%2d %4s %2s %4d", div, elemType, recdType, year);
        if ( n == 4 )
        {
            Interval = getNWSInterval(elemType);
            TimeOffset = Interval;
            if ( Interval > 0 )
            {
                fileFormat = NWS_SPACE_DELIMITED;
                hasStationName = true;
                break;
            }
        }

        // --- check for NWS coma delimited format
        n = sscanf(line, "%6ld,%2d,%4s", sn2, div, elemType);
        if ( n == 3 )
        {
            Interval = getNWSInterval(elemType);
            TimeOffset = Interval;
            if ( Interval > 0 )
            {
                fileFormat = NWS_COMMA_DELIMITED;
                break;
            }
        }

        // --- check for NWS comma delimited format w/ station name
        n = sscanf(line[37], "%2d,%4s,%2s,%4d", div, elemType, recdType, year);
        if ( n == 4 )
        {
            Interval = getNWSInterval(elemType);
            TimeOffset = Interval;
            if ( Interval > 0 )
            {
                fileFormat = NWS_COMMA_DELIMITED;
                hasStationName = true;
                break;
            }
        }

        // --- check for NWS TAPE format
        n = sscanf(line, "%3s%6ld%2d%4s", recdType, sn2, div, elemType);
        if ( n == 4 )
        {
            Interval = getNWSInterval(elemType);
            TimeOffset = Interval;
            if ( Interval > 0 )
            {
                fileFormat = NWS_TAPE;
                break;
            }
        }

        // --- check for NWS Online Retrieval format
        n = sscanf(line, "%5s%6ld", coopID, sn2);
        if ( n == 2 && strcmp(coopID, "COOP:") == 0 )
        {
            fileFormat = findNWSOnlineFormat(f, line);
            break;
        }

        // --- check for AES type
        n = sscanf(line, "%7ld%3d%2d%2d%3d", sn2, year, month, day, elem);
        if ( n == 5 )
        {
            if ( elem == 123 && line.length >= 185 )
            {
                fileFormat = AES_HLY;
                Interval = 3600;
                TimeOffset = Interval;
                UnitsFactor = 1.0/MMperINCH;
                break;
            }
        }

        // --- check for CMC types
        n = sscanf(line, "%7ld%4d%2d%2d%3d", sn2, year, month, day, elem);
        if ( n == 5 )
        {
            if ( elem == 159 && line.length >= 691 )
            {
                fileFormat = CMC_FIF;
                Interval = 900;
            }
            else if ( elem == 123 && line.length >= 186 )
            {
                fileFormat = CMC_HLY;
                Interval = 3600;
            }
            if ( fileFormat == CMC_FIF || fileFormat == CMC_HLY )
            {
                TimeOffset = Interval;
                UnitsFactor = 1.0/MMperINCH;
                break;
            }
        }

        // --- check for standard format
        if ( parseStdLine(line, year, month, day, hour, minute, x) )
        {
            fileFormat = STD_SPACE_DELIMITED;
            RainType = Gage[i].rainType;
            Interval = Gage[i].rainInterval;
            if ( Gage[i].rainUnits == SI ) UnitsFactor = 1.0/MMperINCH;
            TimeOffset = 0;
            StationID = Gage[i].staID;
            break;
        }
        (hdrLines)++;

    }
    if ( fileFormat != UNKNOWN_FORMAT ) Gage[i].rainInterval = Interval;
    return fileFormat;
}

//=============================================================================
// FILE *f, char *line
function findNWSOnlineFormat(f, line)
//
//  Input:   f = pointer to rainfall data file
//           line = line read from rainfall data file
//  Output:
//  Purpose: determines the file format for an NWS Online Retrieval data file.
//
{
    let n;
    let fileFormat = UNKNOWN_FORMAT;
    let str;

    // --- read in the first header line of the file
    rewind(f);
    fgets(line, MAXLINE, f);

    // --- if 'HPCP' appears then file is for hourly data
    if ( (str = strstr(line, "HPCP")) != null )
    {
        Interval = 3600;
        TimeOffset = Interval;
        ValueOffset = str - line;
        fileFormat = NWS_ONLINE_60;
    }

    // --- if 'QPCP" appears then file is for 15 minute data
    else if ( (str = strstr(line, "QPCP")) != null )
    {
        Interval = 900;
        TimeOffset = Interval;
        ValueOffset = str - line;
        fileFormat = NWS_ONLINE_15;
    }
    else return UNKNOWN_FORMAT;

    // --- find position in line where rainfall date begins
    //     (11 characters before last occurrence of ':')
    // --- read in first line of data
    for (n = 1; n <= 5; n++)
    {
        if ( fgets(line, MAXLINE, f) == null ) return UNKNOWN_FORMAT;
        if ( strstr(line, "COOP:") == null ) continue;

        // --- find pointer to last occurrence of time separator character (':')
        str = strrchr(line, ':');
        if ( str == null ) return UNKNOWN_FORMAT;

        // --- use pointer arithmetic to convert pointer to character position
        n = str - line;
        DataOffset = n - 11;
        return fileFormat;
    }
    return UNKNOWN_FORMAT;
}

//=============================================================================
// char *elemType
function getNWSInterval(elemType)
//
//  Input:   elemType = code from NWS rainfall file
//  Output:  returns rainfall recording interval (sec)
//  Purpose: decodes NWS rain gage recording interval value
//
{
    if      ( strcmp(elemType, "HPCP") == 0 ) return 3600; // 1 hr rainfall
    else if ( strcmp(elemType, "QPCP") == 0 ) return 900;  // 15 min rainfall
    else if ( strcmp(elemType, "QGAG") == 0 ) return 900;  // 15 min rainfall
    else return 0;
}

//=============================================================================
// FILE *f, int fileFormat, int hdrLines, DateTime day1,
//    DateTime day2
function readFile(f, fileFormat, hdrLines, day1, day2)
//
//  Input:   f          = ptr. to gage's rainfall data file
//           fileFormat = code of data file's format
//           hdrLines   = number of header lines in data file
//           day1       = starting day of record of interest
//           day2       = ending day of record of interest
//  Output:  none
//  Purpose: reads rainfall records from gage's data file to interface file.
//
{
    let line;
    let  i, n;

    rewind(f);
    RainStats.startDate  = NO_DATE;
    RainStats.endDate    = NO_DATE;
    RainStats.periodsRain = 0;
    RainStats.periodsMissing = 0;
    RainStats.periodsMalfunc = 0;
    RainAccum = 0.0;
    AccumStartDate = NO_DATE;
    PreviousDate = NO_DATE;

    for (i = 1; i <= hdrLines; i++)
    {
        if ( fgets(line, MAXLINE, f) == null ) return;
    }
    while ( fgets(line, MAXLINE, f) != null )
    {
       switch (fileFormat)
       {
         case STD_SPACE_DELIMITED:
          n = readStdLine(line, day1, day2);
          break;

         case NWS_TAPE:
         case NWS_SPACE_DELIMITED:
         case NWS_COMMA_DELIMITED:
         case NWS_ONLINE_60:
         case NWS_ONLINE_15:
           n = readNWSLine(line, fileFormat, day1, day2);
           break;

         case AES_HLY:
         case CMC_FIF:
         case CMC_HLY:
           n = readCMCLine(line, fileFormat, day1, day2);
           break;

         default:
           n = -1;
           break;
       }
       if ( n < 0 ) break;
    }
}

//=============================================================================
// char *line, int fileFormat, DateTime day1, DateTime day2
function readNWSLine(line, fileFormat, day1, day2)
//
//  Input:   line       = line of data from rainfall data file
//           fileFormat = code of data file's format
//           day1       = starting day of record of interest
//           day2       = ending day of record of interest
//  Output:  returns -1 if past end of desired record, 0 if data line could
//           not be read successfully or 1 if line read successfully
//  Purpose: reads a line of data from a rainfall data file and writes its
//           data to the rain interface file.
//
{
    let      flag1, flag2, isMissing;
    let      date1;
    let      result = 1;
    let      k, y, m, d, n;
    let      hour, minute;
    let      v;
    let      x;
    let      lineLength = line.length-1;
    let      nameLength = 0;

    // --- get year, month, & day from line
    switch ( fileFormat )
    {
      case NWS_TAPE:
        if ( lineLength <= 30 ) return 0;
        if (sscanf(line[17], "%4d%2d%4d%3d", y, m, d, n) < 4) return 0;
        k = 30;
        break;

      case NWS_SPACE_DELIMITED:
        if ( hasStationName ) nameLength = 31;
        if ( lineLength <= 28 + nameLength ) return 0;
        k = 18 + nameLength;
        if (sscanf(line[k], "%4d %2d %2d", y, m, d) < 3) return 0;
        k = k + 10;
        break;

      case NWS_COMMA_DELIMITED:
        if ( lineLength <= 28 ) return 0;
        if ( sscanf(line[18], "%4d,%2d,%2d", y, m, d) < 3 ) return 0;
        k = 28;
        break;

      case NWS_ONLINE_60:
      case NWS_ONLINE_15:
        if ( lineLength <= DataOffset + 23 ) return 0;
        if ( sscanf(line[DataOffset], "%4d%2d%2d", y, m, d) < 3 ) return 0;
        k = DataOffset + 8;
        break;

      default: return 0;
    }

    // --- see if date is within period of record requested
    date1 = datetime_encodeDate(y, m, d);
    if ( day1 != NO_DATE && date1 < day1 ) return 0;
    if ( day2 != NO_DATE && date1 > day2 ) return -1;

    // --- read each recorded rainfall time, value, & codes from line
    while ( k < lineLength )
    {
        flag1 = 0;
        flag2 = 0;
        v = 99999;
        hour = 25;
        minute = 0;
        switch ( fileFormat )
        {
          case NWS_TAPE:
            n = sscanf(line[k], "%2d%2d%6ld%c%c",
                       hour, minute, v, flag1, flag2);
            k += 12;
            break;

          case NWS_SPACE_DELIMITED:
            n = sscanf(line[k], " %2d%2d %6ld %c %c",
                       hour, minute, v, flag1, flag2);
            k += 16;
            break;

          case NWS_COMMA_DELIMITED:
            n = sscanf(line[k], ",%2d%2d,%6ld,%c,%c",
                       hour, minute, v, flag1, flag2);
            k += 16;
            break;

          case NWS_ONLINE_60:
          case NWS_ONLINE_15:
              n = sscanf(line[k], " %2d:%2d", hour, minute);
              n += readNwsOnlineValue(line[ValueOffset], v, flag1);

              // --- ending hour 0 is really hour 24 of previous day
              if ( hour == 0 )
              {
                  hour = 24;
                  date1 -= 1.0;
              }
              k += lineLength;
              break;

          default: n = 0;
        }

        // --- check that we at least have an hour, minute & value
        //     (codes might be left off of the line)
        if ( n < 3 || hour >= 25 ) break;

        // --- set special condition code & update daily & hourly counts

        setCondition(flag1);
        if ( Condition == DELETED_PERIOD ||
             Condition == MISSING_PERIOD ||
             flag1 == 'M' ) isMissing = true;
        else if ( v >= 9999 ) isMissing = true;
        else isMissing = false;

        // --- handle accumulation codes
        if ( flag1 == 'a' )
        {
            AccumStartDate = date1 + datetime_encodeTime(hour, minute, 0);
        }
        else if ( flag1 == 'A' )
        {
            saveAccumRainfall(date1, hour, minute, v);
        }

        // --- handle all other conditions
        else
        {
            // --- convert rain measurement to inches & save it
            x = v / 100.0;
            if ( x > 0 || isMissing )
                saveRainfall(date1, hour, minute, x, isMissing);
        }

        // --- reset condition code if special condition period ended
        if ( flag1 == 'A' || flag1 == '}' || flag1 == ']') Condition = 0;
    }
    return result;
}

//=============================================================================
// char* s, long* v, char* flag
function readNwsOnlineValue(s, v, flag)
//
//  Input:   s = portion of rainfall record in NWS online format
//  Output:  v = rainfall amount in hundreths of an inch
//           flag = special condition flag
//           returns number of items read from s.
//  Purpose: reads rainfall value and condition flag from a NWS online
//           rainfall record.
//
{
    let    n;
    let  x = 99.99;                                                         //(5.1.013)

    // --- check for newer format of decimal inches
    if ( strchr(s, '.') )
    {
        n = sscanf(s, "%f %c", x, flag);

        // --- convert to integer hundreths of an inch
        v = (100.0 * x + 0.5);
    }

    // --- older format of hundreths of an inch
    else n = sscanf(s, "%ld %c", v, flag);
    return n;
}

//=============================================================================
// char flag
function  setCondition(flag)
{
    switch ( flag )
    {
      case 'a':
      case 'A':
        Condition = ACCUMULATED_PERIOD;
        break;
      case '{':
      case '}':
        Condition = DELETED_PERIOD;
        break;
      case '[':
      case ']':
        Condition = MISSING_PERIOD;
        break;
      default:
        Condition = NO_CONDITION;
    }
}

//=============================================================================
// char *line, int fileFormat, DateTime day1, DateTime day2
function readCMCLine(line, fileFormat, day1, day2)
//
//  Input:   line = line of data from rainfall data file
//           fileFormat = code of data file's format
//           day1 = starting day of record of interest
//           day2 = ending day of record of interest
//  Output:  returns -1 if past end of desired record, 0 if data line could
//           not be read successfully or 1 if line read successfully
//  Purpose: reads a line of data from an AES or CMC rainfall data file and
//           writes its data to the rain interface file.
//
{
    let     flag, isMissing;
    let     date1;
    let     sn, v;
    let     col, j, jMax, elem, y, m, d, hour, minute;
    let     x;

    // --- get year, month, day & element code from line
    if ( fileFormat == AES_HLY )
    {
        if ( sscanf(line, "%7ld%3d%2d%2d%3d", sn, y, m, d, elem) < 5 )
            return 0;
        if ( y < 100 ) y = y + 2000;
        else           y = y + 1000;
        col = 17;
    }
    else
    {
        if ( sscanf(line, "%7ld%4d%2d%2d%3d", sn, y, m, d, elem) < 5 )
            return 0;
        col = 18;
    }

    // --- see if date is within period of record requested
    date1 = datetime_encodeDate(y, m, d);
    if ( day1 != NO_DATE && date1 < day1 ) return 0;
    if ( day2 != NO_DATE && date1 > day2 ) return -1;

    // --- make sure element code is for rainfall
    if ( fileFormat == AES_HLY && elem != 123 ) return 0;
    else if ( fileFormat == CMC_FIF && elem != 159 ) return 0;
    else if ( fileFormat == CMC_HLY && elem != 123 ) return 0;

    // --- read rainfall from each recording interval
    hour = 0;                          // starting hour
    minute = 0;                        // starting minute
    jMax = 24;                         // # recording intervals
    if ( fileFormat == CMC_FIF ) jMax = 96;
    for (j=1; j<=jMax; j++)
    {
        if ( sscanf(line[col], "%6ld%c", v, flag) < 2 ) return 0;
        col += 7;
        if ( v == -99999 ) isMissing = true;
        else               isMissing = false;

        // --- convert rain measurement from 0.1 mm to inches and save it
        x = (float)( v / 10.0 / MMperINCH);
        if ( x > 0 || isMissing)
        {
            saveRainfall(date1, hour, minute, x, isMissing);
        }

        // --- update hour & minute for next interval
        if ( fileFormat == CMC_FIF )
        {
            minute += 15;
            if ( minute == 60 )
            {
                minute = 0;
                hour++;
            }
        }
        else hour++;
    }
    return 1;
}

//=============================================================================
// char *line, DateTime day1, DateTime day2
function readStdLine(line, day1, day2)
//
//  Input:   line = line of data from a standard rainfall data file
//           day1 = starting day of record of interest
//           day2 = ending day of record of interest
//  Output:  returns -1 if past end of desired record, 0 if data line could
//           not be read successfully or 1 if line read successfully
//  Purpose: reads a line of data from a standard rainfall data file and
//           writes its data to the rain interface file.
//
{
    let date1;
    let date2;
    let      year, month, day, hour, minute;
    let    x;

    // --- parse data from input line
    if (!parseStdLine(line, year, month, day, hour, minute, x)) return 0;

    // --- see if date is within period of record requested
    date1 = datetime_encodeDate(year, month, day);
    if ( day1 != NO_DATE && date1 < day1 ) return 0;
    if ( day2 != NO_DATE && date1 > day2 ) return -1;

    // --- see if record is out of sequence
    date2 = date1 + datetime_encodeTime(hour, minute, 0);
    if ( date2 <= PreviousDate )
    {
        report_writeErrorMsg(ERR_RAIN_FILE_SEQUENCE, Gage[GageIndex].fname);
        report_writeLine(line);
        return -1;
    }
    PreviousDate = date2;

    switch (RainType)
    {
      case RAINFALL_INTENSITY:
        x = x * Interval / 3600.0;
        break;

      case CUMULATIVE_RAINFALL:
        if ( x >= RainAccum )
        {
            x = x - RainAccum;
            RainAccum += x;
        }
        else RainAccum = x;
        break;
    }
    x *= UnitsFactor;

    // --- save rainfall to binary interface file
    saveRainfall(date1, hour, minute, x, false);
    return 1;
}

//=============================================================================
// char *line, int *year, int *month, int *day, int *hour,
//    int *minute, float *value
function parseStdLine(line, year, month, day, hour, minute, value)
//
//  Input:   line = line of data from a standard rainfall data file
//  Output:  *year = year when rainfall occurs
//           *month = month of year when rainfall occurs
//           *day = day of month when rainfall occurs
//           *hour = hour of day when rainfall occurs
//           *minute = minute of hour when rainfall occurs
//           *value = rainfall value (user units);
//           returns 0 if data line could not be parsed successfully or
//           1 if line parsed successfully
//  Purpose: parses a line of data from a standard rainfall data file.
//
{
    let n;
    let token;

    n = sscanf(line, "%s %d %d %d %d %d %f", token, year, month, day, hour, minute, value);
    if ( n < 7 ) return 0;
    if ( StationID != null && !strcomp(token, StationID) ) return 0;
    return 1;
}

//=============================================================================
// DateTime date1, int hour, int minute, long v
function saveAccumRainfall(date1, hour, minute, v)
//
//  Input:   date1 = date of latest rainfall reading (in DateTime format)
//           hour = hour of day of latest rain reading
//           minute = minute of hour of latest rain reading
//           v = accumulated rainfall reading in hundreths of inches
//  Output:  none
//  Purpose: divides accumulated rainfall evenly into individual recording
//           periods over the accumulation period and writes each period's
//           rainfall to the binary rainfall file.
//
{
    let date2;
    let n, j;
    let x;

    // --- return if accumulated start date is missing
    if ( AccumStartDate == NO_DATE ) return;

    // --- find number of recording intervals over accumulation period
    date2 = date1 + datetime_encodeTime(hour, minute, 0);
    n = (datetime_timeDiff(date2, AccumStartDate) / Interval) + 1;

    // --- update count of rain or missing periods
    if ( v == 99999 )
    {
        RainStats.periodsMissing += n;
        return;
    }
    RainStats.periodsRain += n;

    // --- divide accumulated amount evenly into each period
    x = v / n / 100.0;

    // --- save this amount to file for each period
    if ( x > 0.0 )
    {
        date2 = datetime_addSeconds(AccumStartDate, -TimeOffset);
        if ( RainStats.startDate == NO_DATE ) RainStats.startDate = date2;
        for (j = 0; j < n; j++)
        {
            fwrite(date2, sizeof(DateTime), 1, Frain.file);
            fwrite(x, sizeof(float), 1, Frain.file);
            date2 = datetime_addSeconds(date2, Interval);
            RainStats.endDate = date2;
        }
    }

    // --- reset start of accumulation period
    AccumStartDate = NO_DATE;
}


//=============================================================================
// DateTime date1, int hour, int minute, float x, char isMissing
function saveRainfall(date1, hour, minute, x, isMissing)
//
//  Input:   date1 = date of rainfall reading (in DateTime format)
//           hour = hour of day of current rain reading
//           minute = minute of hour of current rain reading
//           x = rainfall reading in inches
//           isMissing = true if rainfall value is missing
//  Output:  none
//  Purpose: writes current rainfall reading from an external rainfall file
//           to project's binary rainfall file.
//
{
    let date2;
    let seconds;

    if ( isMissing ) RainStats.periodsMissing++;
    else             RainStats.periodsRain++;

    // --- if rainfall not missing then save it to rainfall interface file
    if ( !isMissing )
    {
        seconds = 3600*hour + 60*minute - TimeOffset;
        date2 = datetime_addSeconds(date1, seconds);

        // --- write date & value (in inches) to interface file
        fwrite(date2, sizeof(DateTime), 1, Frain.file);
        fwrite(x, sizeof(float), 1, Frain.file);

        // --- update actual start & end of record dates
        if ( RainStats.startDate == NO_DATE ) RainStats.startDate = date2;
        RainStats.endDate = date2;
    }
}
//=============================================================================
