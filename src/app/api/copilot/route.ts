/**
 * AI Copilot narrative.
 *
 * The model receives the evidence packet the deterministic engines produced and
 * explains it. Two properties are enforced here rather than trusted to the
 * client:
 *
 *  1. The system prompt is prepended server-side from COPILOT_SYSTEM_PROMPT, so
 *     a client cannot replace it or slip extra "facts" into the packet.
 *  2. The reply is audited for guaranteed-profit and fabricated-probability
 *     claims. The audit FLAGS; it never rewrites the model's words.
 *
 * With no model configured this reports itself unavailable rather than
 * producing an analysis from nothing.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guard";
import { COPILOT_SYSTEM_PROMPT, auditCopilotOutput } from "@/lib/trading/copilot";

const bodySchema = z.object({
  // Only the evidence packet: the system prompt is not client-supplied.
  evidence: z.string().min(1).max(200_000),
  model: z.string().min(1).max(200).optional(),
});

export async function POST(request: Request) {
  const denied = await requireSession();
  if (denied) return denied;

  const baseUrl = process.env.COPILOT_BASE_URL?.trim();
  const apiKey = process.env.COPILOT_API_KEY?.trim();
  const defaultModel = process.env.COPILOT_MODEL?.trim();

  if (!baseUrl || !defaultModel) {
    return NextResponse.json(
      {
        error:
          "COPILOT UNAVAILABLE — set COPILOT_BASE_URL and COPILOT_MODEL in .env to enable the " +
          "narrative. All scores and levels on the page are computed without it.",
      },
      { status: 503 }
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid Copilot request" }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: parsed.data.model ?? defaultModel,
        messages: [
          { role: "system", content: COPILOT_SYSTEM_PROMPT },
          { role: "user", content: parsed.data.evidence },
        ],
        // Low temperature: the task is faithful explanation, not creativity.
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!upstream.ok) {
      return NextResponse.json(
        { error: `COPILOT UNAVAILABLE — the model endpoint returned ${upstream.status}.` },
        { status: 502 }
      );
    }

    const payload = (await upstream.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    const text = payload?.choices?.[0]?.message?.content ?? "";

    if (!text) {
      return NextResponse.json(
        { error: "COPILOT UNAVAILABLE — the model returned an empty response." },
        { status: 502 }
      );
    }

    return NextResponse.json({ text, audit: auditCopilotOutput(text) });
  } catch {
    // Never surface the upstream error verbatim: it can carry the endpoint and
    // parts of the request.
    return NextResponse.json(
      { error: "COPILOT UNAVAILABLE — could not reach the configured model endpoint." },
      { status: 502 }
    );
  }
}
