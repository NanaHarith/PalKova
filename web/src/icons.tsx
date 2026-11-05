// One stroke family for the board's few glyphs: 24px grid, 1.75 stroke, round joins.
import type { Channel } from "./api";

const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const PhoneIcon = () => (
  <svg {...base}><path d="M6.5 3.5h3l1.5 4-2 1.25a11 11 0 0 0 6.25 6.25L16.5 13l4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z" /></svg>
);

export const WebIcon = () => (
  <svg {...base}><rect x="3" y="4.5" width="18" height="14" rx="2" /><path d="M3 8.5h18M6.5 6.5h.01M9 6.5h.01" /></svg>
);

export const AgentIcon = () => (
  <svg {...base}><rect x="5" y="7" width="14" height="11" rx="3" /><path d="M12 7V4.5M9.5 12h.01M14.5 12h.01M9.5 15h5" /></svg>
);

export const AlertIcon = () => (
  <svg {...base}><path d="M12 4 2.5 20h19L12 4Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
);

export const MicIcon = () => (
  <svg {...base} width={26} height={26}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" /></svg>
);

/** The command bar's submit: the return key's hooked arrow. */
export const ReturnIcon = () => (
  <svg {...base}><path d="M19 5v6.5a3 3 0 0 1-3 3H5.5" /><path d="m9.5 10.5-4 4 4 4" /></svg>
);

export const channelIcon: Record<Channel, () => React.JSX.Element> = { phone: PhoneIcon, web: WebIcon, agent: AgentIcon };
export const channelLabel: Record<Channel, string> = { phone: "Phone", web: "Web", agent: "Agent" };
