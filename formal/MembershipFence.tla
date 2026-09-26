-------------------------- MODULE MembershipFence ---------------------------
EXTENDS Naturals

CONSTANT FaultyReplacement
ASSUME FaultyReplacement \in BOOLEAN

Members == {"m0", "m1"}
Sessions == {"s0", "s1"}
None == "none"

VARIABLES currentMember, currentSession, leaseMember, leaseSession, writes, staleWrite
vars == <<currentMember, currentSession, leaseMember, leaseSession, writes, staleWrite>>

Init == /\ currentMember = "m0"
        /\ currentSession = "s0"
        /\ leaseMember = None
        /\ leaseSession = None
        /\ writes = 0
        /\ staleWrite = FALSE

Acquire(m, s) == /\ m \in Members /\ s \in Sessions
                 /\ leaseMember = None
                 /\ currentMember = m /\ currentSession = s
                 /\ leaseMember' = m /\ leaseSession' = s
                 /\ UNCHANGED <<currentMember, currentSession, writes, staleWrite>>

Replace(m, s) == /\ m \in Members /\ s \in Sessions
                 /\ (m # currentMember \/ s # currentSession)
                 /\ (leaseMember = None \/ FaultyReplacement)
                 /\ currentMember' = m /\ currentSession' = s
                 /\ UNCHANGED <<leaseMember, leaseSession, writes, staleWrite>>

Write == /\ leaseMember # None
         /\ writes < 2
         /\ writes' = writes + 1
         /\ staleWrite' = (staleWrite \/
                          ~(leaseMember = currentMember /\ leaseSession = currentSession))
         /\ UNCHANGED <<currentMember, currentSession, leaseMember, leaseSession>>

Release == /\ leaseMember # None
           /\ leaseMember' = None /\ leaseSession' = None
           /\ UNCHANGED <<currentMember, currentSession, writes, staleWrite>>

Next == (\E m \in Members, s \in Sessions: Acquire(m, s))
        \/ (\E m \in Members, s \in Sessions: Replace(m, s))
        \/ Write \/ Release
Spec == Init /\ [][Next]_vars

TypeOK == /\ currentMember \in Members /\ currentSession \in Sessions
          /\ leaseMember \in Members \cup {None}
          /\ leaseSession \in Sessions \cup {None}
          /\ writes \in 0..2 /\ staleWrite \in BOOLEAN
LeaseExact == leaseMember = None \/
              (leaseMember = currentMember /\ leaseSession = currentSession)
NoStaleWrite == ~staleWrite
=============================================================================
