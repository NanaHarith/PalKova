// The Takings screen's assistant, on AG Studio's Agent Framework. Our own agent, the kitchen analyst,
// takes every new conversation: it knows the restaurant, answers from the data itself, and hands any
// change to the dashboard to Studio's built-in lead agent, which plans and delegates to the page,
// widget and data agents. Every agent's turns go through our server, which holds the key.
import { createAiHarness, directLlmRunner, type AgAiAgentDefinition, type AgAiHarnessSetup } from "ag-studio";
import { palkovaAdapter } from "./adapter";

const KITCHEN = `You are the kitchen analyst for Kaveri Kitchen, a small Indian restaurant (pickup only), working
inside its owner's Takings dashboard. Orders reach the restaurant three ways: Phone (a voice agent),
Web (talk to order in the browser), and Agent (a customer's own AI assistant over MCP). Every order is
paid through PayPal before the kitchen cooks it, so every row here is money the restaurant took.
Takings is what the restaurant kept: paid minus refunded. Money is in US dollars.

Answer questions about sales from the data with the query tool, in two or three plain sentences with
the figures. Read the page first when the question is about what the dashboard shows. When the owner
asks to add, change, filter or remove anything on the dashboard, hand it to the lead agent with
delegateTo and say what you asked for. Never invent a figure; if the data can't answer, say so.
There are no customer names in this data, and you should not ask for any.`;

export function takingsAi(): AgAiHarnessSetup {
  const adapter = palkovaAdapter();
  return ({ api }) => createAiHarness(api, ({ tools, builtIn }) => {
    const kitchen: AgAiAgentDefinition = {
      id: "kitchen",
      name: "Kitchen analyst",
      description: "Answers questions about Kaveri Kitchen's takings and hands dashboard changes to the lead agent.",
      // The model has no clock: "this week" and "yesterday" need today's date, in the restaurant's terms.
      instructions: () => `${KITCHEN}\n\nToday is ${new Date().toLocaleDateString("en-US",
        { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. Weeks start on Monday.`,
      tools: () => [tools.studio.viewSchema(), tools.studio.viewPage(), tools.studio.executeQuery(),
        tools.delegateTo(["lead"]), tools.renameThread()],
      maxTurns: 12,
    } as AgAiAgentDefinition;
    return {
      primary: "kitchen",
      agents: [
        directLlmRunner({ ...kitchen, adapter }),
        ...Object.values(builtIn).map((agent) => directLlmRunner({ ...agent, adapter })),
      ],
      promptStarters: [
        { label: "Best day this week", prompt: "Which day this week took the most, and how much?" },
        { label: "Agent orders", prompt: "How much came in through AI agents compared with phone and web?" },
        { label: "Add takings by hour", prompt: "Add a chart of takings by hour of the day." },
      ],
    };
  });
}
