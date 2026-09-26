---------------------------- MODULE GraphAttempt ----------------------------
EXTENDS Naturals

CONSTANT FaultyRevision, FaultyRepairBound
ASSUME FaultyRevision \in BOOLEAN /\ FaultyRepairBound \in BOOLEAN

VARIABLES revision, aAttempt, aState, bState, bInput, traversals
vars == <<revision, aAttempt, aState, bState, bInput, traversals>>

Init == /\ revision = 0
          /\ aAttempt = 1
        /\ aState = "ready"
        /\ bState = "waiting"
        /\ bInput = 0
        /\ traversals = 0

ClaimA == /\ aState = "ready"
          /\ aState' = "running"
          /\ UNCHANGED <<revision, aAttempt, bState, bInput, traversals>>

AchieveA == /\ aState = "running"
            /\ aState' = "achieved"
            /\ bState' = "ready"
            /\ UNCHANGED <<revision, aAttempt, bInput, traversals>>

ClaimB == /\ bState = "ready"
          /\ aState = "achieved"
          /\ bState' = "running"
          /\ bInput' = aAttempt
          /\ UNCHANGED <<revision, aAttempt, aState, traversals>>

AchieveB == /\ bState = "running"
            /\ bState' = "achieved"
            /\ UNCHANGED <<revision, aAttempt, aState, bInput, traversals>>

FailB == /\ bState = "running"
         /\ bState' = "failed"
         /\ UNCHANGED <<revision, aAttempt, aState, bInput, traversals>>

Repair == /\ bState = "failed"
          /\ (traversals < 2 \/ FaultyRepairBound)
          /\ aAttempt < 4
          /\ traversals' = traversals + 1
          /\ aAttempt' = aAttempt + 1
          /\ aState' = "ready"
          /\ bState' = "waiting"
          /\ bInput' = 0
          /\ UNCHANGED revision

ReviseA == /\ revision = 0
           /\ aAttempt < 4
           /\ revision' = 1
           /\ aAttempt' = aAttempt + 1
           /\ aState' = "ready"
           /\ IF FaultyRevision
                 THEN UNCHANGED <<bState, bInput>>
                 ELSE /\ bState' = "waiting" /\ bInput' = 0
           /\ UNCHANGED traversals

Next == ClaimA \/ AchieveA \/ ClaimB \/ AchieveB \/ FailB \/ Repair \/ ReviseA
Spec == Init /\ [][Next]_vars

TypeOK == /\ revision \in 0..1
          /\ aAttempt \in 1..4
          /\ aState \in {"ready", "running", "achieved"}
          /\ bState \in {"waiting", "ready", "running", "achieved", "failed"}
          /\ bInput \in 0..4
          /\ traversals \in 0..3

AcceptedLineage == bState \in {"running", "achieved"} =>
                   (aState = "achieved" /\ bInput = aAttempt)
RepairBound == traversals <= 2
NoRevisionRepairInterleave == ~(revision = 1 /\ traversals > 0)
=============================================================================
