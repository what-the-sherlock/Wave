import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import { readAccessToken } from "../auth/cookies.js";
import { UnauthorizedError } from "../errors/AppError.js";
import * as uploadService from "./upload.service.js";
import type { PresignBody } from "./upload.schemas.js";

function requireAccessToken(req: Request): string {
  const token = readAccessToken(req);
  if (!token) {
    throw new UnauthorizedError("No session found");
  }
  return token;
}

export const presign = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as PresignBody;
  const accessToken = requireAccessToken(req);
  const result = await uploadService.presignUpload(req.claims!.sub, accessToken, body);
  res.status(201).json(result);
});

export const getDownload = asyncHandler(async (req: Request, res: Response) => {
  const accessToken = requireAccessToken(req);
  const variant = req.query.variant === "thumb" ? "thumb" : "original";
  const url = await uploadService.getDownloadUrl(
    req.claims!.sub,
    accessToken,
    req.params.attachmentId!,
    variant,
  );
  res.status(200).json({ url });
});
