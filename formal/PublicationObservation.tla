----------------------- MODULE PublicationObservation ------------------------
EXTENDS Naturals, FiniteSets

CONSTANT Fault
Faults == {"none", "earlyPublication", "partialObservation",
           "trustFence", "skipReplay", "retryRetirement"}
ASSUME Fault \in Faults

Revisions == {1, 2}
VARIABLES authorityRev, fenceRev, events, alive, retirementFailed,
          pendingDelivery, deliveredBad, replayClaim, replayDegraded,
          staleRetry, crashed, reopened, readState, readTarget,
          stagedCursor, observationBad
vars == <<authorityRev, fenceRev, events, alive, retirementFailed,
          pendingDelivery, deliveredBad, replayClaim, replayDegraded,
          staleRetry, crashed, reopened, readState, readTarget,
          stagedCursor, observationBad>>

Init == /\ authorityRev = 0 /\ fenceRev = 0 /\ events = {}
        /\ alive = TRUE /\ retirementFailed = FALSE
        /\ pendingDelivery = 0 /\ deliveredBad = FALSE
        /\ replayClaim = 0 /\ replayDegraded = 0 /\ staleRetry = FALSE
        /\ crashed = FALSE /\ reopened = FALSE
        /\ readState = "unread" /\ readTarget = 0
        /\ stagedCursor = 0 /\ observationBad = FALSE

Commit == /\ alive /\ authorityRev < 2
          /\ authorityRev' = authorityRev + 1
          /\ retirementFailed' = FALSE
          /\ UNCHANGED <<fenceRev, events, alive, pendingDelivery,
                         deliveredBad, replayClaim, replayDegraded,
                         staleRetry, crashed, reopened, readState,
                         readTarget, stagedCursor, observationBad>>

Retire == /\ alive /\ fenceRev < authorityRev
          /\ fenceRev' = authorityRev /\ retirementFailed' = FALSE
          /\ UNCHANGED <<authorityRev, events, alive, pendingDelivery,
                         deliveredBad, replayClaim, replayDegraded,
                         staleRetry, crashed, reopened, readState,
                         readTarget, stagedCursor, observationBad>>

RetireFails == /\ alive /\ fenceRev < authorityRev
               /\ ~retirementFailed
               /\ retirementFailed' = TRUE
               /\ UNCHANGED <<authorityRev, fenceRev, events, alive,
                              pendingDelivery, deliveredBad, replayClaim,
                              replayDegraded, staleRetry, crashed, reopened,
                              readState, readTarget, stagedCursor,
                              observationBad>>

Publish(r) == /\ alive /\ r \in Revisions /\ r \notin events
              /\ (r <= authorityRev \/ Fault = "earlyPublication")
              /\ events' = events \cup {r}
              /\ UNCHANGED <<authorityRev, fenceRev, alive, retirementFailed,
                             pendingDelivery, deliveredBad, replayClaim,
                             replayDegraded, staleRetry, crashed, reopened,
                             readState, readTarget, stagedCursor,
                             observationBad>>

QueueDelivery == /\ alive /\ authorityRev > 0
                 /\ pendingDelivery = 0
                 /\ pendingDelivery' = authorityRev
                 /\ UNCHANGED <<authorityRev, fenceRev, events, alive,
                                retirementFailed, deliveredBad, replayClaim,
                                replayDegraded, staleRetry, crashed, reopened,
                                readState, readTarget, stagedCursor,
                                observationBad>>

Deliver == /\ alive /\ pendingDelivery > 0
           /\ (pendingDelivery = authorityRev \/
                (Fault = "trustFence" /\ retirementFailed /\
                 (fenceRev = 0 \/ pendingDelivery = fenceRev)))
           /\ pendingDelivery' = 0
           /\ deliveredBad' = (deliveredBad \/ pendingDelivery # authorityRev)
           /\ UNCHANGED <<authorityRev, fenceRev, events, alive,
                          retirementFailed, replayClaim, replayDegraded,
                          staleRetry, crashed, reopened, readState,
                          readTarget, stagedCursor, observationBad>>

Crash == /\ alive /\ ~crashed
         /\ alive' = FALSE /\ crashed' = TRUE
         /\ UNCHANGED <<authorityRev, fenceRev, events, retirementFailed,
                        pendingDelivery, deliveredBad, replayClaim,
                        replayDegraded, staleRetry, reopened, readState,
                        readTarget, stagedCursor, observationBad>>

Reopen == /\ ~alive /\ crashed
          /\ alive' = TRUE /\ reopened' = TRUE
          /\ UNCHANGED <<authorityRev, fenceRev, events, retirementFailed,
                         pendingDelivery, deliveredBad, replayClaim,
                         replayDegraded, staleRetry, crashed, readState,
                         readTarget, stagedCursor, observationBad>>

\* A current exact replay may repair its missing Task event. A superseded
\* operation does not republish historical Task coordinates.
ReplayRepair == /\ alive /\ authorityRev > 0
                /\ authorityRev \notin events
                /\ events' = events \cup {authorityRev}
                /\ replayClaim' = authorityRev
                /\ UNCHANGED <<authorityRev, fenceRev, alive,
                               retirementFailed, pendingDelivery,
                               deliveredBad, replayDegraded, staleRetry,
                               crashed, reopened, readState, readTarget,
                               stagedCursor, observationBad>>

ReplayMissing == /\ alive /\ authorityRev > 0
                 /\ authorityRev \notin events
                 /\ (Fault = "skipReplay")
                 /\ replayClaim' = authorityRev
                 /\ UNCHANGED <<authorityRev, fenceRev, events, alive,
                                retirementFailed, pendingDelivery,
                                deliveredBad, replayDegraded, staleRetry,
                                crashed, reopened, readState, readTarget,
                                stagedCursor, observationBad>>

ReplayDegrade == /\ alive /\ authorityRev > 0
                 /\ authorityRev \notin events
                 /\ replayDegraded' = authorityRev
                 /\ UNCHANGED <<authorityRev, fenceRev, events, alive,
                                retirementFailed, pendingDelivery,
                                deliveredBad, replayClaim, staleRetry,
                                crashed, reopened, readState, readTarget,
                                stagedCursor, observationBad>>

ReplayOld(r) == /\ alive /\ r \in Revisions /\ r < authorityRev
                /\ staleRetry' = (staleRetry \/ Fault = "retryRetirement")
                /\ UNCHANGED <<authorityRev, fenceRev, events, alive,
                               retirementFailed, pendingDelivery,
                               deliveredBad, replayClaim, replayDegraded,
                               crashed, reopened, readState, readTarget,
                               stagedCursor, observationBad>>

ReadPartial == /\ alive /\ Cardinality(events) > stagedCursor
               /\ readState = "unread"
               /\ readState' = "partial"
               /\ readTarget' = Cardinality(events)
               /\ UNCHANGED <<authorityRev, fenceRev, events, alive,
                              retirementFailed, pendingDelivery,
                              deliveredBad, replayClaim, replayDegraded,
                              staleRetry, crashed, reopened, stagedCursor,
                              observationBad>>

ReadComplete == /\ alive /\ Cardinality(events) > stagedCursor
                /\ readState \in {"unread", "partial"}
                /\ readState' = "complete"
                /\ readTarget' = Cardinality(events)
                /\ UNCHANGED <<authorityRev, fenceRev, events, alive,
                               retirementFailed, pendingDelivery,
                               deliveredBad, replayClaim, replayDegraded,
                               staleRetry, crashed, reopened, stagedCursor,
                               observationBad>>

Stage == /\ alive /\ readTarget > stagedCursor
         /\ (readState = "complete" \/
              (Fault = "partialObservation" /\ readState = "partial"))
         /\ stagedCursor' = readTarget
         /\ observationBad' = (observationBad \/ readState # "complete")
         /\ readState' = "unread" /\ readTarget' = 0
         /\ UNCHANGED <<authorityRev, fenceRev, events, alive,
                        retirementFailed, pendingDelivery, deliveredBad,
                        replayClaim, replayDegraded, staleRetry, crashed,
                        reopened>>

Next == Commit \/ Retire \/ RetireFails
        \/ (\E r \in Revisions: Publish(r))
        \/ QueueDelivery \/ Deliver \/ Crash \/ Reopen
        \/ ReplayRepair \/ ReplayMissing \/ ReplayDegrade
        \/ (\E r \in Revisions: ReplayOld(r))
        \/ ReadPartial \/ ReadComplete \/ Stage
Spec == Init /\ [][Next]_vars

TypeOK == /\ authorityRev \in 0..2 /\ fenceRev \in 0..2
          /\ events \subseteq Revisions /\ alive \in BOOLEAN
          /\ retirementFailed \in BOOLEAN /\ pendingDelivery \in 0..2
          /\ deliveredBad \in BOOLEAN /\ replayClaim \in 0..2
          /\ replayDegraded \in 0..2 /\ staleRetry \in BOOLEAN
          /\ crashed \in BOOLEAN /\ reopened \in BOOLEAN
          /\ readState \in {"unread", "partial", "complete"}
          /\ readTarget \in 0..2 /\ stagedCursor \in 0..2
          /\ observationBad \in BOOLEAN

CommitBeforePublication == events \subseteq (1..authorityRev)
CurrentDeliveryOnly == ~deliveredBad
TruthfulReplay == replayClaim = 0 \/ replayClaim \in events
NoStaleRetirement == ~staleRetry
CompleteBeforeAdvance == ~observationBad
NoFutureObservation == stagedCursor <= Cardinality(events)

\* Deliberately false coverage probes, checked in separate configs.
NoCrashReplayWitness == ~(reopened /\ replayClaim > 0)
NoRetirementGapWitness == ~(retirementFailed /\ fenceRev < authorityRev)
=============================================================================
