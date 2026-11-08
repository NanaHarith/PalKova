// The Takings page as first opened: four figures, takings by day and by channel, dish sales, the pairs
// that sell together, and the paid orders behind them. The owner (or the agents) can change any of it.
import type { AgReportState } from "ag-studio";

const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text }, ...(subtitle ? { subtitle: { enabled: true, text: subtitle } } : {}),
});
const figure = (text: string, id: string, aggregation: "sum" | "avg" | "countd") => ({
  type: "value" as const,
  dataMapping: { value: [{ id, aggregation }] },
  format: { ...title(text), style: { typography: { fontFamily: "Barlow Condensed, Barlow, sans-serif", fontWeight: 700 }, color: "#1C1519" } },
});

export const takingsReport: AgReportState = {
  selectedPageId: "takings",
  pages: [{
    id: "takings",
    name: "Takings",
    layout: { columns: 24 },
    widgets: {
      takings: figure("Takings", "orders.takings", "sum"),
      orders: figure("Paid orders", "orders.id", "countd"),
      average: figure("Average order", "orders.paid", "avg"),
      refunded: figure("Refunded", "orders.refunded", "sum"),
      byDay: {
        type: "column-chart-grouped",
        dataMapping: { categoryKey: [{ id: "orders.day" }], valueKey: [{ id: "orders.takings", aggregation: "sum" }] },
        format: title("Takings by day"),
      },
      byChannel: {
        type: "donut-chart",
        dataMapping: { categoryKey: [{ id: "orders.channel" }], valueKey: [{ id: "orders.takings", aggregation: "sum" }] },
        format: title("By channel", "Phone, web, and AI agents over MCP"),
      },
      dishes: {
        type: "bar-chart-grouped",
        dataMapping: { categoryKey: [{ id: "lines.dish" }], valueKey: [{ id: "lines.sales", aggregation: "sum" }] },
        sort: [{ field: { id: "lines.sales", aggregation: "sum" }, direction: "desc" }],
        format: title("Dish sales"),
      },
      together: {
        type: "ordered-together",
        dataMapping: { order: [{ id: "lines.order_id" }], dish: [{ id: "lines.dish" }] },
        format: title("Ordered together", "Dish pairs in the same order"),
      },
      paidOrders: {
        type: "grid",
        dataMapping: { cols: [{ id: "orders.number" }, { id: "orders.placed" }, { id: "orders.channel" },
          { id: "orders.items" }, { id: "orders.paid" }, { id: "orders.refunded" }, { id: "orders.takings" }] },
        format: title("Paid orders"),
      },
    },
    widgetLayout: {
      takings: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 7 },
      orders: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 7 },
      average: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 7 },
      refunded: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 7 },
      byDay: { xTrack: 0, yTrack: 7, xSpan: 16, ySpan: 18 },
      byChannel: { xTrack: 16, yTrack: 7, xSpan: 8, ySpan: 18 },
      dishes: { xTrack: 0, yTrack: 25, xSpan: 13, ySpan: 22 },
      together: { xTrack: 13, yTrack: 25, xSpan: 11, ySpan: 22 },
      paidOrders: { xTrack: 0, yTrack: 47, xSpan: 24, ySpan: 22 },
    },
  }],
} as unknown as AgReportState;  // the custom widget's type isn't in the default registry's union
