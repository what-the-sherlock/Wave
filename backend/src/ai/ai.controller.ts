import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import * as aiService from "./ai.service.js";
import type { AskQuestionBody } from "./ai.schemas.js";
import type { CachedOrQueuedResult } from "./ai.service.js";

function respondQueuedOrCached(res: Response, result: CachedOrQueuedResult): void {
  if (result.cached) {
    res.status(200).json({ status: "done", summary: result.cached });
    return;
  }
  res.status(202).json({ status: "queued", requestId: result.requestId });
}

export const ask = asyncHandler(async (req: Request, res: Response) => {
  const { question } = req.body as AskQuestionBody;
  const result = await aiService.askQuestion(req.claims!.sub, req.workspace!.id, question);
  res.status(202).json({ status: "queued", requestId: result.requestId });
});

export const catchup = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiService.requestCatchupSummary(req.claims!.sub, req.channel!.id);
  respondQueuedOrCached(res, result);
});

export const summarizeThread = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiService.requestThreadSummary(req.claims!.sub, req.channel!.id, req.params.messageId!);
  respondQueuedOrCached(res, result);
});
