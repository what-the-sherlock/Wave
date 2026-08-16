import { z } from "zod";

export const askQuestionSchema = z.object({
  question: z.string().trim().min(1, "Question is required").max(2000),
});
export type AskQuestionBody = z.infer<typeof askQuestionSchema>;
