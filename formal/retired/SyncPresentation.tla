----------------------- MODULE SyncPresentation -----------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC

\* Contract revision 2: one exact leader Session, two turns, one pending
\* slot, abstract Worker evidence, and at most two native journal pages.
\* Native/framework presentation shares one rule. Exact identity checks,
\* persistence, historical decoding, and TypeScript refinement stay external.
CONSTANTS AckAt, KeepPendingOnAckFailure, ImmediatePendingReturn,
          DiscardOnlyOnAckFalse, RefuseSequential, SkipEmptyPages
VARIABLE s
vars == <<s>>
Evidence == {"active", "actuation_pending", "run_state_unknown", "delivery_state_unknown"}
Proofs == {"valid", "absent", "rejected"}
AckResults == {"success", "false", "throw"}
Phases == {"request", "message", "tools", "waiting", "tool_done", "turn_end", "done"}
Pages == {<<>>, <<"empty">>, <<"visible">>, <<"empty", "visible">>, <<"empty", "empty">>}
UnsettledReasons(workers) ==
  (IF "active" \in workers THEN {"still_active"} ELSE {})
  \cup (workers \ {"active"})

Init ==
  /\ s \in [phase : {"request"}, turn : {1}, pending : 0..1,
             source : {"native", "framework"}, candidate : {0}, proof : {"absent"},
             presented : {{}}, observed : {{}}, requestObserved : {{}},
             discarded : {FALSE}, resolved : {0},
             lateStage : {FALSE}, preservedLate : {FALSE},
             workers : SUBSET Evidence, waitZero : BOOLEAN,
             tick : {0}, visible : {0}, pages : Pages, inFlight : {FALSE},
             duplicate : {"none"}, sequential : {"none"}, replayed : {FALSE},
             outcome : {"none"}, responseWorkers : {{}}, unsettled : {{}},
             responseTick : {0}, responseVisible : {0}]

\* Resolve only the exact captured candidate. Failed/absent/rejected proof
\* never commits observation. A result staged after the request stays intact.
ResolveCandidate(r, result) ==
  IF r.candidate = 0 THEN [r EXCEPT !.preservedLate = r.lateStage]
  ELSE IF r.pending # r.candidate
       THEN [r EXCEPT !.resolved = r.candidate, !.preservedLate = r.lateStage]
       ELSE LET ok == r.proof = "valid" /\ result = "success"
                keep == (~ok /\ r.proof = "valid" /\ KeepPendingOnAckFailure)
                        \/ (DiscardOnlyOnAckFalse /\
                            (r.proof # "valid" \/ result = "throw"))
            IN [r EXCEPT !.pending = IF keep THEN @ ELSE 0,
                         !.observed = IF ok THEN @ \cup {r.candidate} ELSE @,
                         !.discarded = ~ok, !.resolved = r.candidate]

ProviderRequest ==
  /\ s.phase = "request"
  /\ \E proof \in Proofs:
       s' = [s EXCEPT !.phase = "message", !.candidate = s.pending, !.proof = proof,
             !.requestObserved = s.observed, !.discarded = FALSE]

\* Label 4 is distinct from all candidates staged by the two native turns.
StageAfterRequest ==
  /\ s.phase = "message" /\ ~s.lateStage /\ s.candidate # 4
  /\ s' = [s EXCEPT !.pending = 4, !.lateStage = TRUE]

AssistantMessageEnd ==
  /\ s.phase = "message"
  /\ \E result \in AckResults:
       LET r == [s EXCEPT !.phase = "tools",
                  !.presented = IF s.candidate = 0 \/ s.proof = "absent"
                                THEN @ ELSE @ \cup {s.candidate}]
       IN s' = IF AckAt = "message_end" THEN ResolveCandidate(r, result) ELSE r

\* Error/abort/pending stop reasons do not present or resolve the candidate.
\* Framework retry/discard implementation remains a separate runtime check.
ErrorOrAbort ==
  /\ s.phase = "message"
  /\ s' = [s EXCEPT !.phase = "turn_end", !.candidate = 0, !.proof = "absent"]

StartSync ==
  /\ s.phase = "tools"
  /\ s' = IF s.pending # 0
          THEN [s EXCEPT !.phase = "tool_done",
                !.outcome = IF s.pending = s.candidate THEN "pending_conflict" ELSE "refused"]
          ELSE [s EXCEPT !.phase = "waiting", !.inFlight = TRUE,
                !.tick = 0, !.visible = 0, !.outcome = "none"]

ParallelSync ==
  /\ s.inFlight /\ s.duplicate = "none"
  /\ s' = [s EXCEPT !.duplicate = "refused_observation_in_progress"]

SequentialSync ==
  /\ s.phase = "tool_done" /\ s.pending # 0 /\ s.sequential = "none"
  /\ s.outcome \in {"updates", "caught_up", "unsettled"}
  /\ s' = [s EXCEPT !.sequential = IF RefuseSequential
                THEN "refused_observation_in_progress" ELSE "pending_conflict"]

SameCallReplay ==
  /\ s.phase = "tool_done" /\ s.pending # 0 /\ ~s.replayed
  /\ s.outcome \in {"updates", "caught_up", "unsettled"}
  /\ s' = [s EXCEPT !.replayed = TRUE]

\* A full quiet interval; wait=0 does one immediate recheck. Empty pages
\* must be traversed before a liveness-only result can represent the cursor.
Recheck ==
  /\ s.phase = "waiting" /\ s.tick = 0 /\ Len(s.pages) = 0
  /\ s.workers \cap {"active", "actuation_pending"} # {}
  /\ s' = [s EXCEPT !.tick = 1]

ResolveWorker ==
  /\ s.phase = "waiting"
  /\ \E w \in s.workers:
       s' = [s EXCEPT !.workers = @ \ {w}, !.tick = 0]

ReadPage ==
  /\ s.phase = "waiting" /\ Len(s.pages) > 0 /\ s.visible = 0
  /\ s' = IF Head(s.pages) = "empty" /\ ~SkipEmptyPages
          THEN [s EXCEPT !.phase = "tool_done", !.pending = s.turn + 1,
                 !.outcome = "updates", !.responseVisible = 0, !.inFlight = FALSE]
          ELSE [s EXCEPT !.pages = Tail(@),
                 !.visible = IF Head(s.pages) = "visible" THEN 1 ELSE 0]

JournalChange ==
  /\ s.phase = "waiting" /\ Len(s.pages) = 0 /\ s.visible = 0
  /\ s' = [s EXCEPT !.visible = 1]

CanReturn ==
  s.visible = 1
  \/ (Len(s.pages) = 0 /\
      IF "active" \in s.workers
      THEN s.waitZero /\ s.tick = 1
      ELSE IF "actuation_pending" \in s.workers
           THEN ImmediatePendingReturn \/ s.tick = 1
           ELSE TRUE)

FinishSync ==
  /\ s.phase = "waiting" /\ CanReturn
  /\ s' = [s EXCEPT !.phase = "tool_done", !.pending = s.turn + 1,
            !.outcome = IF s.visible = 1 THEN "updates"
                       ELSE IF s.workers = {} THEN "caught_up" ELSE "unsettled",
            !.responseWorkers = s.workers, !.responseTick = s.tick,
            !.unsettled = IF s.visible = 1 THEN {} ELSE UnsettledReasons(s.workers),
            !.responseVisible = s.visible, !.inFlight = FALSE, !.source = "native"]

ToolsEnd ==
  /\ s.phase = "tool_done"
  /\ s' = [s EXCEPT !.phase = "turn_end"]

TurnEnd ==
  /\ s.phase = "turn_end"
  /\ \E result \in AckResults:
       LET r == IF AckAt = "turn_end" THEN ResolveCandidate(s, result) ELSE s
       IN s' = [r EXCEPT !.phase = IF s.turn = 2 THEN "done" ELSE "request",
                  !.turn = IF s.turn = 2 THEN @ ELSE @ + 1,
                  !.candidate = 0, !.proof = "absent", !.resolved = 0,
                  !.lateStage = FALSE, !.preservedLate = FALSE,
                  !.duplicate = "none", !.sequential = "none", !.replayed = FALSE]

Next == ProviderRequest \/ StageAfterRequest \/ AssistantMessageEnd \/ ErrorOrAbort
        \/ StartSync \/ ParallelSync \/ SequentialSync \/ SameCallReplay
        \/ Recheck \/ ResolveWorker \/ ReadPage \/ JournalChange
        \/ FinishSync \/ ToolsEnd \/ TurnEnd

TypeOK ==
  /\ s.phase \in Phases /\ s.turn \in 1..2
  /\ s.pending \in 0..4 /\ s.candidate \in 0..4 /\ s.resolved \in 0..4
  /\ s.proof \in Proofs /\ s.presented \subseteq 1..4 /\ s.observed \subseteq 1..4
  /\ s.requestObserved \subseteq 1..4 /\ s.discarded \in BOOLEAN
  /\ s.workers \subseteq Evidence /\ s.responseWorkers \subseteq Evidence
  /\ s.unsettled \subseteq {"still_active", "actuation_pending", "run_state_unknown", "delivery_state_unknown"}
  /\ s.tick \in 0..1 /\ s.responseTick \in 0..1
  /\ s.visible \in 0..1 /\ s.responseVisible \in 0..1 /\ s.pages \in Pages
  /\ s.source \in {"native", "framework"}
  /\ s.outcome \in {"none", "pending_conflict", "refused", "updates", "caught_up", "unsettled"}
  /\ s.duplicate \in {"none", "refused_observation_in_progress"}
  /\ s.sequential \in {"none", "refused_observation_in_progress", "pending_conflict"}
  /\ s.waitZero \in BOOLEAN /\ s.inFlight \in BOOLEAN /\ s.replayed \in BOOLEAN
  /\ s.lateStage \in BOOLEAN /\ s.preservedLate \in BOOLEAN

Wasted == s.outcome = "pending_conflict" \/ s.sequential = "pending_conflict"
          \/ (s.outcome = "updates" /\ s.responseVisible = 0)
NoWastedSyncAfterPresentation == ~Wasted
NoEmptyUpdates == s.outcome = "updates" => s.responseVisible > 0
NoUnpresentedObservationAdvance == s.observed \subseteq s.presented
NoDiscardAdvance == s.discarded => s.observed = s.requestObserved
NoStuckPending == s.resolved = 0 \/ s.pending # s.resolved
NoStuckPendingWithoutProof == s.proof = "absent" => NoStuckPending
PreserveLaterCandidate == s.preservedLate /\ s.phase = "tools" => s.pending = 4
LivenessOutcomeC4 ==
  s.outcome \in {"caught_up", "updates", "unsettled"} =>
    /\ (s.outcome = "updates") = (s.responseVisible = 1)
    /\ (s.outcome = "caught_up") = (s.responseVisible = 0 /\ s.responseWorkers = {})
    /\ s.unsettled = IF s.responseVisible = 1 THEN {} ELSE UnsettledReasons(s.responseWorkers)
    /\ (s.responseVisible = 0
         /\ s.responseWorkers \cap {"active", "actuation_pending"} = {} => s.responseTick = 0)
    /\ (s.responseVisible = 0 /\ "active" \in s.responseWorkers =>
         s.waitZero /\ s.responseTick = 1)
    /\ (s.responseVisible = 0 /\ "active" \notin s.responseWorkers
         /\ "actuation_pending" \in s.responseWorkers => s.responseTick = 1)
ParallelRefusal == s.duplicate # "none" => s.duplicate = "refused_observation_in_progress"
SequentialRefusal == s.sequential # "none" => s.sequential = "refused_observation_in_progress"

\* Fair local scheduling does not require an active Worker to settle.
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)
WaitTerminatesC4 ==
  (s.phase = "waiting" /\ ("active" \notin s.workers \/ s.waitZero))
    ~> (s.phase \in {"tool_done", "turn_end", "request", "done"})
=============================================================================
