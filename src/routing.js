//-----------------------------------------------------------------------------
//   routing.c
//
//   Project:  EPA SWMM5
//   Version:  5.1
//   Date:     03/19/14  (Build 5.1.000)
//             09/15/14  (Build 5.1.007)
//             04/02/15  (Build 5.1.008)
//             08/05/15  (Build 5.1.010)
//             08/01/16  (Build 5.1.011)
//             03/14/17  (Build 5.1.012)
//             05/10/18  (Build 5.1.013)
//   Author:   L. Rossman (EPA)
//             M. Tryby (EPA)
//
//   Conveyance system routing functions.
//
//   Build 5.1.007:
//   - Nodal evap/seepage losses computed using conditions at start of time step.
//   - DWF pollutant concentrations ignored if DWF is negative.
//   - Separate mass balance accounting made for storage evap. & seepage.
//   - Nodal mass balance accounting for negative lateral inflows corrected.
//
//   Build 5.1.008:
//   - Initialization of flow and quality routing systems moved here from swmm5.c.
//   - Lateral inflows now evaluated at start (not end) of time step.
//   - Flows from LID drains included in lateral inflows.
//   - Conduit evap/seepage losses multiplied by number of barrels before
//     being added into mass balances.
//
//   Build 5.1.010:
//   - Time when a link's setting is changed is recorded.
//
//   Build 5.1.011:
//   - Support added for limiting flow routing to specific events.
//
//   Build 5.1.012:
//   - routing_execute() was re-written so that Routing Events and
//     Skip Steady Flow options work together correctly.
//
//   Build 5.1.013:
//   - Support added for evaluating controls rules at RuleStep time interval.
//   - Back flow through Outfall nodes now treated as External Inflows for
//     mass balance purposes.
//   - Global infiltration factor for storage seepage set in routing_execute.
//
//-----------------------------------------------------------------------------

//-----------------------------------------------------------------------------
// Shared variables
//-----------------------------------------------------------------------------
var SortedLinks = [];
var  NextEvent;
var  BetweenEvents;
var NewRuleTime;                                                     //(5.1.013)

//-----------------------------------------------------------------------------
//  External functions (declared in funcs.h)
//-----------------------------------------------------------------------------
// routing_open            (called by swmm_start in swmm5.c)
// routing_getRoutingStep  (called by swmm_step in swmm5.c)
// routing_execute         (called by swmm_step in swmm5.c)
// routing_close           (called by swmm_end in swmm5.c)

//=============================================================================

function routing_open()
//
//  Input:   none
//  Output:  returns an error code
//  Purpose: initializes the routing analyzer.
//
{
    // --- open treatment system
    if ( !treatmnt_open() ) return ErrorCode;

    // --- topologically sort the links
    SortedLinks = null;
    if ( Nobjects[LINK] > 0 )
    {
        //SortedLinks = (int *) calloc(Nobjects[LINK], sizeof(int));
        SortedLinks = new Array(Nobjects[LINK]);
        if ( !SortedLinks )
        {
            report_writeErrorMsg(ERR_MEMORY, "");
            return ErrorCode;
        }
        toposort_sortLinks(SortedLinks);
        if ( ErrorCode ) return ErrorCode;
    }

    // --- open any routing interface files
    iface_openRoutingFiles();

    // --- initialize flow and quality routing systems
    flowrout_init(RouteModel);
    if ( Fhotstart1.mode == NO_FILE ) qualrout_init();

    // --- initialize routing events
    if ( NumEvents > 0 ) sortEvents();
    NextEvent = 0;
    BetweenEvents = (NumEvents > 0);
    NewRuleTime = 0.0;                                                         //(5.1.013)
    return ErrorCode;
}

//=============================================================================
// int routingModel
function routing_close(routingModel)
//
//  Input:   routingModel = routing method code
//  Output:  none
//  Purpose: closes down the routing analyzer.
//
{
    // --- close any routing interface files
    iface_closeRoutingFiles();

    // --- free allocated memory
    flowrout_close(routingModel);
    treatmnt_close();
    FREE(SortedLinks);
}

//=============================================================================

////  This function was modified for release 5.1.013.  ////                    //(5.1.013)
// int routingModel, double fixedStep
function routing_getRoutingStep(routingModel, fixedStep)
//
//  Input:   routingModel = routing method code
//           fixedStep = user-supplied time step (sec)
//  Output:  returns a routing time step (sec)
//  Purpose: determines time step used for flow routing at current time period.
//
{
    var date1, date2, nextTime;
    var routingStep = 0.0, nextRuleTime, nextRoutingTime;

    if ( Nobjects[LINK] == 0 ) return fixedStep;

    // --- find largest step possible if between routing events
    if ( NumEvents > 0 && BetweenEvents )
    {
        nextTime = MIN(NewRunoffTime, ReportTime);
        date1 = getDateTime(NewRoutingTime);
        date2 = getDateTime(nextTime);
        if ( date2 > date1 && date2 < swmm_Event[NextEvent].start )
        {
            routingStep = (nextTime - NewRoutingTime) / 1000.0;
        }
        else
        {
            date1 = getDateTime(NewRoutingTime + 1000.0 * fixedStep);
            if ( date1 < swmm_Event[NextEvent].start ) return fixedStep;
        }
    }

    // --- otherwise use a regular flow-routing based time step
    if (routingStep == 0.0)
    {
        routingStep = flowrout_getRoutingStep(routingModel, fixedStep);
    }

    // --- determine if control rule time interval reached
    if (RuleStep > 0)
    {
        nextRuleTime = NewRuleTime + 1000. * RuleStep;
        nextRoutingTime = NewRoutingTime + 1000. * routingStep;
        if (nextRoutingTime >= nextRuleTime)
        {
            routingStep = (nextRuleTime - NewRoutingTime) / 1000.0;
        }
    }
    return routingStep;
}

//=============================================================================
// int routingModel, double routingStep
function routing_execute(routingModel, routingStep)
//
//  Input:   routingModel = routing method code
//           routingStep = routing time step (sec)
//  Output:  none
//  Purpose: executes the routing process at the current time period.
//
{
    let      j;
    let      stepCount = 1;
    let      actionCount = 0;
    let      inSteadyState = false;
    let currentDate;
    let   stepFlowError;

    // --- update continuity with current state
    //     applied over 1/2 of time step
    if ( ErrorCode ) return;
    massbal_updateRoutingTotals(routingStep/2.);

    // --- find new link target settings that are not related to
    // --- control rules (e.g., pump on/off depth limits)
    for (j=0; j<Nobjects[LINK]; j++) link_setTargetSetting(j);

    // --- find date of start of current time period                           //(5.1.013)
    currentDate = getDateTime(NewRoutingTime);                                 //
                                                                               //
    // --- evaluate control rules if next evluation time reached               //
    if (RuleStep == 0 || Math.abs(NewRoutingTime - NewRuleTime) < 1.0)             //
    {                                                                          //   
        controls_evaluate(currentDate, currentDate - StartDateTime,            //
            routingStep / SECperDAY);                                          //
    }                                                                          //

    // --- change each link's actual setting if it differs from its target
    for (j=0; j<Nobjects[LINK]; j++)
    {
        if ( Link[j].targetSetting != Link[j].setting )
        {
            // --- update time when link was switched between open & closed
            if ( Link[j].targetSetting * Link[j].setting == 0.0 )
                Link[j].timeLastSet = currentDate;

            // --- implement the change in the link's setting
            link_setSetting(j, routingStep);
            actionCount++;
        } 
    }

    // --- update value of elapsed routing time (in milliseconds)
    OldRoutingTime = NewRoutingTime;
    NewRoutingTime = NewRoutingTime + 1000.0 * routingStep;

    // --- see if control rule evaluation time should be advanced              //(5.1.013)
    if (Math.abs(NewRoutingTime - (NewRuleTime + 1000.0*RuleStep)) < 1)            //
        NewRuleTime += 1000.0 * RuleStep;                                      //

    // --- initialize mass balance totals for time step
    stepFlowError = massbal_getStepFlowError();
    massbal_initTimeStepTotals();

    // --- replace old water quality state with new state
    if ( Nobjects[POLLUT] > 0 )
    {
        for (j=0; j<Nobjects[NODE]; j++) node_setOldQualState(j);
        for (j=0; j<Nobjects[LINK]; j++) link_setOldQualState(j);
    }

    // --- set infiltration factor for storage unit seepage                    //(5.1.013)
    //     (-1 argument indicates global factor is used)                       //(5.1.013)
    infil_setInfilFactor(-1);                                                  //(5.1.013)

    // --- initialize lateral inflows at nodes
    for (j = 0; j < Nobjects[NODE]; j++)
    {
        Node[j].oldLatFlow  = Node[j].newLatFlow;
        Node[j].newLatFlow  = 0.0;
    }

    // --- check if can skip non-event periods
    if ( NumEvents > 0 )
    {
        if ( currentDate > swmm_Event[NextEvent].end )
        {
            BetweenEvents = true;
            NextEvent++;
        }
        else if ( currentDate >= swmm_Event[NextEvent].start && BetweenEvents == true )
        {
			BetweenEvents = false;
        }
    }

    // --- if not between routing events
    if ( BetweenEvents == false )
    {
        // --- find evap. & seepage losses from storage nodes
        for (j = 0; j < Nobjects[NODE]; j++)
        {
            Node[j].losses = node_getLosses(j, routingStep); 
        }

        // --- add lateral inflows and evap/seepage losses at nodes
        addExternalInflows(currentDate);
        addDryWeatherInflows(currentDate);
        addWetWeatherInflows(OldRoutingTime);
        addGroundwaterInflows(OldRoutingTime);
        addLidDrainInflows(OldRoutingTime);
        addRdiiInflows(currentDate);
        addIfaceInflows(currentDate);

        // --- check if can skip steady state periods based on flows
        if ( SkipSteadyState )
        {
            if ( OldRoutingTime == 0.0
            ||   actionCount > 0
            ||   Math.abs(stepFlowError) > SysFlowTol
            ||   inflowHasChanged() ) inSteadyState = false;
            else inSteadyState = true;
        }

        // --- find new hydraulic state if system has changed
        if ( inSteadyState == false )
        {
            // --- replace old hydraulic state values with current ones
            for (j = 0; j < Nobjects[LINK]; j++) link_setOldHydState(j);
            for (j = 0; j < Nobjects[NODE]; j++)
            {
                node_setOldHydState(j);
                node_initInflow(j, routingStep);
            }

            // --- route flow through the drainage network
            if ( Nobjects[LINK] > 0 )
            {
                stepCount = flowrout_execute(SortedLinks, routingModel, routingStep);
            }
        }

        // --- route quality through the drainage network
        if ( Nobjects[POLLUT] > 0 && !IgnoreQuality ) 
        {
            qualrout_execute(routingStep);
        }

        // --- remove evaporation, infiltration & outflows from system
        removeStorageLosses(routingStep);
        removeConduitLosses();
        removeOutflows(routingStep);
    }
    else inSteadyState = true;
	
    // --- update continuity with new totals
    //     applied over 1/2 of routing step
    massbal_updateRoutingTotals(routingStep/2.);

    // --- update summary statistics
    if ( RptFlags.flowStats && Nobjects[LINK] > 0 )
    {
        stats_updateFlowStats(routingStep, getDateTime(NewRoutingTime),
                              stepCount, inSteadyState);
    }
}

//=============================================================================
// DateTime currentDate
function addExternalInflows(currentDate)
//
//  Input:   currentDate = current date/time
//  Output:  none
//  Purpose: adds direct external inflows to nodes at current date.
//
{
    let     j, p;
    let  q, w;
    //TExtInflow* inflow;
    var inflow;

    // --- for each node with a defined external inflow
    for (j = 0; j < Nobjects[NODE]; j++)
    {
        inflow = Node[j].extInflow;
        if ( !inflow ) continue;

        // --- get flow inflow
        q = 0.0;
        while ( inflow )
        {
            if ( inflow.type == FLOW_INFLOW )
            {
                q = inflow_getExtInflow(inflow, currentDate);
                break;
            }
            else inflow = inflow.next;
        }
        if ( Math.abs(q) < FLOW_TOL ) q = 0.0;

        // --- add flow inflow to node's lateral inflow
        Node[j].newLatFlow += q;
        massbal_addInflowFlow(EXTERNAL_INFLOW, q);

        // --- add on any inflow (i.e., reverse flow) through an outfall
        if ( Node[j].type == OUTFALL && Node[j].oldNetInflow < 0.0 ) 
        {
            q = q - Node[j].oldNetInflow;
        }

        // --- get pollutant mass inflows
        inflow = Node[j].extInflow;
        while ( inflow )
        {
            if ( inflow.type != FLOW_INFLOW )
            {
                p = inflow.param;
                w = inflow_getExtInflow(inflow, currentDate);
                if ( inflow.type == CONCEN_INFLOW ) w *= q;
                Node[j].newQual[p] += w;
                massbal_addInflowQual(EXTERNAL_INFLOW, p, w);
            }
            inflow = inflow.next;
        }
    }
}

//=============================================================================
// DateTime currentDate
function addDryWeatherInflows(currentDate)
//
//  Input:   currentDate = current date/time
//  Output:  none
//  Purpose: adds dry weather inflows to nodes at current date.
//
{
    let      j, p;
    let      month, day, hour;
    let   q, w;
    //TDwfInflow* inflow;
    let inflow;

    // ret facil
    let returnObj;
    let returnVal;

    // --- get month (zero-based), day-of-week (zero-based),
    //     & hour-of-day for routing date/time
    month = datetime_monthOfYear(currentDate) - 1;
    day   = datetime_dayOfWeek(currentDate) - 1;
    hour  = datetime_hourOfDay(currentDate);

    // --- for each node with a defined dry weather inflow
    for (j = 0; j < Nobjects[NODE]; j++)
    {
        inflow = Node[j].dwfInflow;
        if ( !inflow ) continue;

        // --- get flow inflow (i.e., the inflow whose param code is -1)
        q = 0.0;
        while ( inflow )
        {
            if ( inflow.param < 0 )
            {
                ////////////////////////////////////
                returnObj = {inflow: inflow}
                returnVal = inflow_getDwfInflow(inObj, month, day, hour)
                inflow = returnObj.inflow;
                ////////////////////////////////////
                q = returnVal;
                //q = inflow_getDwfInflow(inflow, month, day, hour);
                break;
            }
            inflow = inflow.next;
        }
        if ( Math.abs(q) < FLOW_TOL ) q = 0.0;

        // --- add flow inflow to node's lateral inflow
        Node[j].newLatFlow += q;
        massbal_addInflowFlow(DRY_WEATHER_INFLOW, q);

        // --- stop if inflow is non-positive
        if ( q <= 0.0 ) continue;

        // --- add default DWF pollutant inflows
        for ( p = 0; p < Nobjects[POLLUT]; p++)
        {
            if ( Pollut[p].dwfConcen > 0.0 )
            {
                w = q * Pollut[p].dwfConcen;
                Node[j].newQual[p] += w;
                massbal_addInflowQual(DRY_WEATHER_INFLOW, p, w);
            }
        }

        // --- get pollutant mass inflows
        inflow = Node[j].dwfInflow;
        while ( inflow )
        {
            if ( inflow.param >= 0 )
            {
                p = inflow.param;
                ////////////////////////////////////
                returnObj = {inflow: inflow}
                returnVal = inflow_getDwfInflow(inObj, month, day, hour)
                inflow = returnObj.inflow;
                ////////////////////////////////////
                w = q * returnVal
                //w = q * inflow_getDwfInflow(inflow, month, day, hour);
                Node[j].newQual[p] += w;
                massbal_addInflowQual(DRY_WEATHER_INFLOW, p, w);

                // --- subtract off any default inflow
                if ( Pollut[p].dwfConcen > 0.0 )
                {
                    w = q * Pollut[p].dwfConcen;
                    Node[j].newQual[p] -= w;
                    massbal_addInflowQual(DRY_WEATHER_INFLOW, p, -w);
                }
            }
            inflow = inflow.next;
        }
    }
}

//=============================================================================
// double routingTime
function addWetWeatherInflows(routingTime)
//
//  Input:   routingTime = elasped time (millisec)
//  Output:  none
//  Purpose: adds runoff inflows to nodes at current elapsed time.
//
{
    let    i, j, p;
    let q, w;
    let f;

    // --- find where current routing time lies between latest runoff times
    if ( Nobjects[SUBCATCH] == 0 ) return;
    f = (routingTime - OldRunoffTime) / (NewRunoffTime - OldRunoffTime);
    if ( f < 0.0 ) f = 0.0;
    if ( f > 1.0 ) f = 1.0;

    // for each subcatchment outlet node,
    // add interpolated runoff flow & pollutant load to node's inflow
    for (i = 0; i < Nobjects[SUBCATCH]; i++)
    {
        j = Subcatch[i].outNode;
        if ( j >= 0)
        {
            // add runoff flow to lateral inflow
            q = subcatch_getWtdOutflow(i, f);     // current runoff flow
            Node[j].newLatFlow += q;
            massbal_addInflowFlow(WET_WEATHER_INFLOW, q);

            // add pollutant load
            for (p = 0; p < Nobjects[POLLUT]; p++)
            {
                w = surfqual_getWtdWashoff(i, p, f);
                Node[j].newQual[p] += w;
                massbal_addInflowQual(WET_WEATHER_INFLOW, p, w);
            }
        }
    }
}

//=============================================================================
// double routingTime
function addGroundwaterInflows(routingTime)
//
//  Input:   routingTime = elasped time (millisec)
//  Output:  none
//  Purpose: adds groundwater inflows to nodes at current elapsed time.
//
{
    let    i, j, p;
    let q, w;
    let f;
    //TGroundwater* gw;
    let gw;

    // --- find where current routing time lies between latest runoff times
    if ( Nobjects[SUBCATCH] == 0 ) return;
    f = (routingTime - OldRunoffTime) / (NewRunoffTime - OldRunoffTime);
    if ( f < 0.0 ) f = 0.0;
    if ( f > 1.0 ) f = 1.0;

    // --- for each subcatchment
    for (i = 0; i < Nobjects[SUBCATCH]; i++)
    {
        // --- see if subcatch contains groundwater
        gw = Subcatch[i].groundwater;
        if ( gw )
        {
            // --- identify node receiving groundwater flow
            j = gw.node;
            if ( j >= 0 )
            {
                // add groundwater flow to lateral inflow
                q = ( (1.0 - f)*(gw.oldFlow) + f*(gw.newFlow) )
                    * Subcatch[i].area;
                if ( Math.abs(q) < FLOW_TOL ) continue;
                Node[j].newLatFlow += q;
                massbal_addInflowFlow(GROUNDWATER_INFLOW, q);

                // add pollutant load (for positive inflow)
                if ( q > 0.0 )
                {
                    for (p = 0; p < Nobjects[POLLUT]; p++)
                    {
                        w = q * Pollut[p].gwConcen;
                        Node[j].newQual[p] += w;
                        massbal_addInflowQual(GROUNDWATER_INFLOW, p, w);
                    }
                }
            }
        }
    }
}

//=============================================================================
// double routingTime
function addLidDrainInflows(routingTime)
//
//  Input:   routingTime = elasped time (millisec)
//  Output:  none
//  Purpose: adds inflows to nodes receiving LID drain flow.
//
{
    let j;
    let f;

    // for each subcatchment
    if ( Nobjects[SUBCATCH] == 0 ) return;
    f = (routingTime - OldRunoffTime) / (NewRunoffTime - OldRunoffTime);
    if ( f < 0.0 ) f = 0.0;
    if ( f > 1.0 ) f = 1.0;
    for (j = 0; j < Nobjects[SUBCATCH]; j++)
    {
        if ( Subcatch[j].area > 0.0 && Subcatch[j].lidArea > 0.0 )
            lid_addDrainInflow(j, f);
    }
}

//=============================================================================
// DateTime currentDate
function addRdiiInflows(currentDate)
//
//  Input:   currentDate = current date/time
//  Output:  none
//  Purpose: adds RDII inflows to nodes at current date.
//
{
    let    i, j, p;
    let q, w;
    let    numRdiiNodes;

    // --- see if any nodes have RDII at current date
    numRdiiNodes = rdii_getNumRdiiFlows(currentDate);

    // --- add RDII flow to each node's lateral inflow
    for (i=0; i<numRdiiNodes; i++)
    {
        rdii_getRdiiFlow(i, j, q);
        if ( j < 0 ) continue;
        if ( Math.abs(q) < FLOW_TOL ) continue;
        Node[j].newLatFlow += q;
        massbal_addInflowFlow(RDII_INFLOW, q);

        // add pollutant load (for positive inflow)
        if ( q > 0.0 )
        {
            for (p = 0; p < Nobjects[POLLUT]; p++)
            {
                w = q * Pollut[p].rdiiConcen;
                Node[j].newQual[p] += w;
                massbal_addInflowQual(RDII_INFLOW, p, w);
            }
        }
    }
}

//=============================================================================
// DateTime currentDate
function addIfaceInflows(currentDate)
//
//  Input:   currentDate = current date/time
//  Output:  none
//  Purpose: adds inflows from routing interface file to nodes at current date.
//
{
    let    i, j, p;
    let q, w;
    let    numIfaceNodes;

    // --- see if any nodes have interface inflows at current date
    if ( Finflows.mode != USE_FILE ) return;
    numIfaceNodes = iface_getNumIfaceNodes(currentDate);

    // --- add interface flow to each node's lateral inflow
    for (i=0; i<numIfaceNodes; i++)
    {
        j = iface_getIfaceNode(i);
        if ( j < 0 ) continue;
        q = iface_getIfaceFlow(i);
        if ( Math.abs(q) < FLOW_TOL ) continue;
        Node[j].newLatFlow += q;
        massbal_addInflowFlow(EXTERNAL_INFLOW, q);

        // add pollutant load (for positive inflow)
        if ( q > 0.0 )
        {
            for (p = 0; p < Nobjects[POLLUT]; p++)
            {
                w = q * iface_getIfaceQual(i, p);
                Node[j].newQual[p] += w;
                massbal_addInflowQual(EXTERNAL_INFLOW, p, w);
            }
        }
    }
}



//=============================================================================

function  inflowHasChanged()
//
//  Input:   none
//  Output:  returns true if external inflows or outfall flows have changed
//           from the previous time step
//  Purpose: checks if the hydraulic state of the system has changed from
//           the previous time step.
//
{
    let    j;
    let diff, qOld, qNew;

    // --- check if external inflows or outfall flows have changed 
    for (j = 0; j < Nobjects[NODE]; j++)
    {
        qOld = Node[j].oldLatFlow;
        qNew = Node[j].newLatFlow;
        if      ( Math.abs(qOld) > TINY ) diff = (qNew / qOld) - 1.0;
        else if ( Math.abs(qNew) > TINY ) diff = 1.0;
        else                    diff = 0.0;
        if ( Math.abs(diff) > LatFlowTol ) return true;
        if ( Node[j].type == OUTFALL || Node[j].degree == 0 )
        {
            qOld = Node[j].oldFlowInflow;
            qNew = Node[j].inflow;
            if      ( Math.abs(qOld) > TINY ) diff = (qNew / qOld) - 1.0;
            else if ( Math.abs(qNew) > TINY ) diff = 1.0;
            else                          diff = 0.0;
            if ( Math.abs(diff) > LatFlowTol ) return true;
        }
    }
    return false;
}

//=============================================================================
// double tStep
function removeStorageLosses(tStep)
//
//  Input:   tStep = routing time step (sec)
//  Output:  none
//  Purpose: adds flow rate lost from all storage nodes due to evaporation
//           & seepage in current time step to overall mass balance totals.
//
{
    let    i;
    let evapLoss = 0.0,
           exfilLoss = 0.0;

    // --- check each storage node
    for ( i = 0; i < Nobjects[NODE]; i++ )
    {
        if (Node[i].type == STORAGE)
        {
            // --- update total system storage losses
            evapLoss += Storage[Node[i].subIndex].evapLoss;
            exfilLoss += Storage[Node[i].subIndex].exfilLoss;
        }
    }

    // --- add loss rates (ft3/sec) to time step's mass balance 
    massbal_addNodeLosses(evapLoss/tStep, exfilLoss/tStep);
}

//=============================================================================

function removeConduitLosses()
//
//  Input:   none
//  Output:  none
//  Purpose: adds flow rate lost from all conduits due to evaporation
//           & seepage over current time step to overall mass balance.
//
{
    let i, k;
    let barrels,
           evapLoss = 0.0,
	       seepLoss = 0.0;

    for ( i = 0; i < Nobjects[LINK]; i++ )
    {
	    if (Link[i].type == CONDUIT)
        {
            // --- retrieve number of barrels
            k = Link[i].subIndex;
            barrels = Conduit[k].barrels;

            // --- update total conduit losses
            evapLoss += Conduit[k].evapLossRate * barrels;
            seepLoss += Conduit[k].seepLossRate * barrels;
        }
    }
    massbal_addLinkLosses(evapLoss, seepLoss);
}

//=============================================================================
// double tStep
function removeOutflows(tStep)
//
//  Input:   none
//  Output:  none
//  Purpose: finds flows that leave the system and adds these to mass
//           balance totals.
//
{
    let    i, p, k;
    let    isFlooded;
    let q, w, v;

    for ( i = 0; i < Nobjects[NODE]; i++ )
    {
        // --- accumulate inflow volume & pollut. load at outfalls
        if ( Node[i].type == OUTFALL && Node[i].inflow > 0.0 )
        {
            k = Node[i].subIndex;
            if ( Outfall[k].routeTo >= 0 )
            {
                v = Node[i].inflow * tStep;
                Outfall[k].vRouted += v;
                for (p = 0; p < Nobjects[POLLUT]; p++)
                    Outfall[k].wRouted[p] += Node[i].newQual[p] * v;
            }
        }

        // --- update mass balance with flow and mass leaving the system
        //     through outfalls and flooded interior nodes
        q = node_getSystemOutflow(i, isFlooded);
        if ( q > 0.0 )                                                         //(5.1.013)
        {
            massbal_addOutflowFlow(q, isFlooded);
            for ( p = 0; p < Nobjects[POLLUT]; p++ )
            {
                w = q * Node[i].newQual[p];
                massbal_addOutflowQual(p, w, isFlooded);
            }
        }
        else massbal_addInflowFlow(EXTERNAL_INFLOW, -q);                       //(5.1.013)

        // --- update mass balance with mass leaving system through negative
        //     lateral inflows (lateral flow was previously accounted for)
        q = Node[i].newLatFlow;
        if ( q < 0.0 )
        {
            for ( p = 0; p < Nobjects[POLLUT]; p++ )
            {
                w = -q * Node[i].newQual[p];
                massbal_addOutflowQual(p, w, false);
            }
        }

    }
}

//=============================================================================

function sortEvents()
//
//  Input:   none
//  Output:  none
//  Purpose: sorts the entries of the Event array in chronological order.
//
{
    let i, j;
    //TEvent temp;
    let temp;

    // Apply simple exchange sort to event list
    for (i = 0; i < NumEvents-1; i++)
    {
        for (j = i+1; j < NumEvents; j++)
        {
            if ( swmm_Event[i].start > swmm_Event[j].start )
            {
                temp = swmm_Event[j];
                swmm_Event[j] = swmm_Event[i];
                swmm_Event[i] = temp;
            }
        }
    }

    // Adjust for overlapping events
    for (i = 0; i < NumEvents-1; i++)
    {
        if ( swmm_Event[i].end > swmm_Event[i+1].start ) swmm_Event[i].end = swmm_Event[i+1].start;
    }
}

//=============================================================================
