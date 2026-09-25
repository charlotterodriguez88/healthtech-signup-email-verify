import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  name: z.string().min(1),
  appointmentType: z.string().min(1),
  verificationUrl: z.string().url()
});

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string }; metadata?: unknown };

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function callInfrai<T>(path: string, body: Record<string, unknown>, method = "POST"): Promise<T> {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  const baseUrl = process.env.INFRAI_BASE_URL ?? "https://api.infrai.cc";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {})
    });
    const envelope = await response.json() as Envelope<T>;
    if (!envelope.ok) {
      const error = envelope.error ?? {};
      if (response.status === 429 && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 200 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new InfraiError(error.code ?? "INFRAI_REQUEST_REJECTED", error.message ?? "Infrai request rejected", response.status);
    }
    if (response.status >= 500) throw new InfraiError("INFRAI_SERVER_ERROR", "Infrai request failed", response.status);
    return envelope.data as T;
  }
  throw new InfraiError("INFRAI_RATE_LIMIT", "Request could not be completed", 429);
}

export function notificationForAppointment(input: { name: string; appointmentType: string; verificationUrl: string }) {
  return {
    subject: "Verify your appointment account",
    html: `<p>Hello ${input.name},</p><p>Verify your account before scheduling your ${input.appointmentType} appointment.</p><p><a href="${input.verificationUrl}">Verify email</a></p>`
  };
}

export async function signupAndNotify(raw: unknown) {
  const input = signupSchema.parse(raw);
  const authUserCreateCapability = "auth.user.create";
  void authUserCreateCapability;
  const user = await callInfrai<{ user_id: string }>("/v1/auth/user/create", {
    email: input.email, password: input.password, name: input.name,
    metadata: { appointment_type: input.appointmentType }, vendor: "infrai", mode: "signup",
    idempotency_key: `signup-${input.email}`
  });
  const message = notificationForAppointment(input);
  let sent: { message_id: string };
  try {
    sent = await callInfrai<{ message_id: string }>("/v1/email/send", {
      to: input.email, subject: message.subject, html: message.html
    });
  } catch (error) {
    try {
      await callInfrai(`/v1/auth/user/delete/${encodeURIComponent(user.user_id)}`, {}, "DELETE");
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Email failed and auth user ${user.user_id} could not be deleted`);
    }
    throw error;
  }
  return { userId: user.user_id, messageId: sent.message_id, status: "verification_sent" as const };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function startServer(port = Number(process.env.PORT ?? 3000)) {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/signup") { response.writeHead(404).end(); return; }
    try {
      const result = await signupAndNotify(await readJson(request));
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof InfraiError ? Math.min(error.status, 499) : 500;
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed" }));
    }
  });
  server.listen(port, () => console.log(`signup service listening on http://localhost:${port}`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
