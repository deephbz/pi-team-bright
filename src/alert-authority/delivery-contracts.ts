export interface InboxMessage {
  /** Communication-authority identity. Optional only for legacy on-disk records. */
  id?: string;
  /** Exact destination membership generation. Absent only on historical legacy records. */
  recipientMembershipId?: string;
  /** Exact sender membership generation when the sender is a current Team member. */
  senderMembershipId?: string;
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
  color?: string;
}

/** An inbox Message after the storage boundary has assigned or migrated its ID. */
export interface IdentifiedInboxMessage extends InboxMessage {
  id: string;
}
