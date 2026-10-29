// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. Each method POSTs `{action, args}` to `/actions` on the local
// server (server/src/index.ts) and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import type { ActionDef } from "../../server/src/framework";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyActionDef = ActionDef<any, any>;

// Note: the unused slot must be `any`, not `unknown` — with `unknown` the
// conditional-type match against ActionDef fails and infers `never`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RequestOf<D> = D extends ActionDef<infer Req, any> ? Req : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResponseOf<D> = D extends ActionDef<any, infer Res> ? Res : never;

export type ActionClient<T extends Record<string, AnyActionDef>> = {
  [K in keyof T]: (args: RequestOf<T[K]>) => Promise<ResponseOf<T[K]>>;
};

export function createActionClient<
  T extends Record<string, AnyActionDef>,
>(): ActionClient<T> {
  const call = async (action: string, args: unknown): Promise<unknown> => {
    const res = await fetch("/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, args }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        data !== null &&
        typeof data === "object" &&
        "error" in data &&
        typeof (data as { error: unknown }).error === "string"
          ? (data as { error: string }).error
          : `request failed: ${res.status}`;
      throw new Error(message);
    }
    return data;
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return (args: unknown) => call(prop, args);
      },
    },
  ) as ActionClient<T>;
}

export const api = createActionClient<typeof Actions>();

// Convenience types so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Shop = ApiResponse<typeof api, "getState">["shops"][number];
export type ApiRequest<C, K extends keyof C> =
  C[K] extends (args: infer A) => unknown ? A : never;
export type ApiResponse<C, K extends keyof C> =
  C[K] extends (args: never) => Promise<infer R> ? R : never;
