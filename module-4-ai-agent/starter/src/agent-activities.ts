// Activities used by the AI agent. Already written for you.
//
//  - callAgentLLM  : one call to the model (the non-deterministic bit — which is
//                    exactly why it must be an activity).
//  - two mock tools the agent can ask to run: a credit report and a compliance
//    check. They return deterministic fake data so the demo is predictable.

import { generateText, tool, CoreMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import type { AgentLLMResponse, AgentMessage } from './models';

// The agent calls an OpenAI-compatible endpoint. In the workshop that's a shared
// LiteLLM proxy on Fly that holds the real OpenAI key — so OPENAI_BASE_URL points
// at the proxy and OPENAI_API_KEY is the proxy's shared key (both injected by the
// sandbox runner; see litellm/README.md). To run it yourself, set OPENAI_API_KEY
// to a real key and leave OPENAI_BASE_URL unset to hit api.openai.com directly.
const openai = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL, // unset -> api.openai.com
  apiKey: process.env.OPENAI_API_KEY,
});

const AGENT_MODEL = process.env.AGENT_MODEL || 'gpt-4o-mini';

// Tool schemas handed to the LLM. Note there is no `execute` — we do NOT let the
// AI SDK run the tools. The workflow dispatches each requested tool call as its
// own activity, so every step shows up in the Temporal history.
const AGENT_TOOL_SCHEMAS = {
  lookupFullCreditReport: tool({
    description:
      'Pull the full credit report for this applicant. Returns delinquencies, recent inquiries, revolving utilization, and credit history length.',
    parameters: z.object({ applicationId: z.string(), ssn: z.string() }),
  }),
  checkComplianceWatchlist: tool({
    description:
      'Run the applicant against OFAC / sanctions watchlists. Returns CLEAR or MATCH with details.',
    parameters: z.object({ applicantName: z.string(), ssn: z.string() }),
  }),
};

export async function callAgentLLM(params: { messages: AgentMessage[] }): Promise<AgentLLMResponse> {
  const result = await generateText({
    model: openai(AGENT_MODEL),
    messages: params.messages as CoreMessage[],
    tools: AGENT_TOOL_SCHEMAS,
    // maxSteps: 1 — stop the AI SDK from auto-looping; the WORKFLOW drives the loop.
    maxSteps: 1,
    temperature: 0,
  });
  return {
    text: result.text ?? '',
    toolCalls: result.toolCalls.map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args as Record<string, unknown>,
    })),
    finishReason: result.finishReason,
    model: AGENT_MODEL,
  };
}

// ---------- Mock tool implementations ----------
// Deterministic from their inputs so the demo behaves predictably without a real DB.

const SIMULATED_PROCESSING_MS = 1500;
const simulateProcessing = () =>
  new Promise<void>((resolve) => setTimeout(resolve, SIMULATED_PROCESSING_MS));

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export async function lookupFullCreditReport(applicationId: string, ssn: string): Promise<string> {
  await simulateProcessing();
  const seed = hashSeed(ssn);
  return JSON.stringify({
    applicationId,
    ssnSuffix: ssn.slice(-4),
    pastDelinquencies: seed % 4,
    recentInquiries: (seed >> 2) % 6,
    revolvingUtilizationPct: 15 + ((seed >> 4) % 55),
    creditHistoryYears: 3 + ((seed >> 6) % 20),
  });
}

export async function checkComplianceWatchlist(applicantName: string, ssn: string): Promise<string> {
  await simulateProcessing();
  // SSNs starting 999 simulate an OFAC/sanctions hit.
  if (ssn.startsWith('999')) {
    return JSON.stringify({
      status: 'MATCH',
      list: 'OFAC-SDN',
      subject: applicantName,
      details: 'Partial name + SSN range match — manual clearance required',
    });
  }
  return JSON.stringify({
    status: 'CLEAR',
    subject: applicantName,
    checkedLists: ['OFAC-SDN', 'FinCEN-314a', 'UK-HMT'],
  });
}
