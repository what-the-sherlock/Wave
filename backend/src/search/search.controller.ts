import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import * as searchService from "./search.service.js";
import type { SearchQuery } from "./search.schemas.js";

export const search = asyncHandler(async (req: Request, res: Response) => {
  const { q } = req.query as unknown as SearchQuery;
  const hits = await searchService.search(req.claims!.sub, req.workspace!.id, q);
  res.status(200).json({
    results: hits.map((hit) => ({
      messageId: hit.id,
      channelId: hit.channelId,
      seq: hit.seq,
      createdAt: hit.createdAt,
      snippet: hit.snippet,
      rank: hit.rank,
    })),
  });
});
