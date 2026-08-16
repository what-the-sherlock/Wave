import { useState } from "react";
import { axiosInstance } from "../lib/axios";
import { extractErrorMessage } from "../lib/utils";
import { useSocketEvent } from "./useSocketEvent";
import type { AiSummaryPayload, Citation } from "../types/ai";

export type AskStatus = "idle" | "pending" | "streaming" | "done" | "error";

/**
 * AI responses are never returned synchronously from the POST call — the
 * backend queues generation and streams the result over the socket
 * (docs/ai-architecture.md §2, §5: "AI requests are queued, never issued
 * synchronously"). Every hook below POSTs to get a `requestId`, then
 * filters the user's `ai.response.*` socket events down to that id —
 * necessary because these events arrive on the same per-user socket
 * room regardless of which component (or how many concurrent requests)
 * triggered them.
 */
export function useAskAi(workspaceId: string | undefined) {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [status, setStatus] = useState<AskStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useSocketEvent<{ requestId: string; delta: string }>("ai.response.chunk", (payload) => {
    if (payload.requestId !== requestId) return;
    setStatus("streaming");
    setText((t) => t + payload.delta);
  });
  useSocketEvent<{ requestId: string; text: string; citations: Citation[] }>("ai.response.done", (payload) => {
    if (payload.requestId !== requestId) return;
    setText(payload.text);
    setCitations(payload.citations ?? []);
    setStatus("done");
  });
  useSocketEvent<{ requestId: string; message: string }>("ai.response.error", (payload) => {
    if (payload.requestId !== requestId) return;
    setStatus("error");
    setError(payload.message);
  });

  const ask = async (question: string) => {
    if (!workspaceId) return;
    setText("");
    setCitations([]);
    setError(null);
    setStatus("pending");
    setRequestId(null);
    try {
      const res = await axiosInstance.post<{ requestId: string }>(`/workspaces/${workspaceId}/ai/ask`, {
        question,
      });
      setRequestId(res.data.requestId);
    } catch (err) {
      setStatus("error");
      setError(extractErrorMessage(err));
    }
  };

  const reset = () => {
    setRequestId(null);
    setText("");
    setCitations([]);
    setStatus("idle");
    setError(null);
  };

  return { ask, reset, status, text, citations, error };
}

export type SummaryStatus = "idle" | "pending" | "done" | "error";

type SummaryResponse = { status: "queued"; requestId: string } | { status: "done"; summary: AiSummaryPayload };

function useSummaryRequest() {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [summary, setSummary] = useState<AiSummaryPayload | null>(null);
  const [status, setStatus] = useState<SummaryStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useSocketEvent<{ requestId: string; summary: AiSummaryPayload }>("ai.response.done", (payload) => {
    if (payload.requestId !== requestId) return;
    setSummary(payload.summary);
    setStatus("done");
  });
  useSocketEvent<{ requestId: string; message: string }>("ai.response.error", (payload) => {
    if (payload.requestId !== requestId) return;
    setStatus("error");
    setError(payload.message);
  });

  const run = async (post: () => Promise<{ data: SummaryResponse }>) => {
    setSummary(null);
    setError(null);
    setStatus("pending");
    setRequestId(null);
    try {
      const res = await post();
      if (res.data.status === "done") {
        setSummary(res.data.summary);
        setStatus("done");
      } else {
        setRequestId(res.data.requestId);
      }
    } catch (err) {
      setStatus("error");
      setError(extractErrorMessage(err));
    }
  };

  return { run, summary, status, error };
}

export function useCatchupSummary(channelId: string) {
  const { run, ...rest } = useSummaryRequest();
  const request = () => run(() => axiosInstance.post<SummaryResponse>(`/channels/${channelId}/ai/catchup`));
  return { request, ...rest };
}

export function useThreadSummary(channelId: string, threadRootId: string) {
  const { run, ...rest } = useSummaryRequest();
  const request = () =>
    run(() => axiosInstance.post<SummaryResponse>(`/channels/${channelId}/messages/${threadRootId}/ai/summarize`));
  return { request, ...rest };
}
