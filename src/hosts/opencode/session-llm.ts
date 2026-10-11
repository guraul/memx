import type { LLMClient } from "../../core/refine/refinement";

export function createSessionLLMClient(
  client: any,
  model?: string,
  onCreated?: (id: string) => void,
): LLMClient {
  return {
    chat: async (params) => {
      let childSessionID: string | undefined;
      try {
        const created = await client.session.create({
          body: { title: "memx-refinement" },
        });
        childSessionID = created.data?.id ?? created.id;
        if (onCreated && childSessionID) onCreated(childSessionID);

        const promptBody: {
          parts: Array<{ type: string; text: string }>;
          system?: string;
          model?: { providerID: string; modelID: string };
        } = {
          parts: [{ type: "text", text: params.messages[0]?.content ?? "" }],
        };
        if (params.system) {
          promptBody.system = params.system;
        }
        if (model) {
          const parts = model.split("/");
          if (parts.length >= 2) {
            promptBody.model = { providerID: parts[0]!, modelID: parts.slice(1).join("/") };
          }
        }

        const res = await client.session.prompt({
          path: { id: childSessionID! },
          body: promptBody,
        });
        const parts = res.data?.parts ?? res.parts ?? [];
        const text = parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text ?? "")
          .join("");
        try {
          await client.app.log({
            body: {
              service: "memx",
              level: "info",
              message: `llm raw(${text.length}): ${text.slice(0, 400)}`,
            },
          });
        } catch {
          // logging must never escape
        }
        return text;
      } finally {
        if (childSessionID) {
          await client.session
            .delete({ path: { id: childSessionID } })
            .catch(() => {});
        }
      }
    },
  };
}