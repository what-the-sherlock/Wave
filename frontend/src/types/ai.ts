export type Citation = { messageId: string; channelId: string; seq: number };

export type AiSummaryPayload = {
  bullets: string[];
  decisions: string[];
  needsYourInput: string[];
  citedMessageIds: string[];
  truncated: boolean;
};

export type AiRequestKind = "CHANNEL_SUMMARY" | "THREAD_SUMMARY" | "WORKSPACE_QA";
