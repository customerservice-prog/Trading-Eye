export const FEATURE_LABELS = {
  trend:{title:"Price trend",positive:"Price has been climbing over the recent window.",negative:"Price has been falling over the recent window."},
  momentum:{title:"Short-term momentum",positive:"The latest real bars are accelerating upward.",negative:"The latest real bars are accelerating downward."},
  volume:{title:"Volume",positive:"The latest real bar has more volume than its recent average.",negative:"The latest real bar has lighter volume than its recent average."},
  volatility:{title:"Volatility",positive:"Price is moving around more than its recent baseline.",negative:"Price movement is relatively calm."},
  orderFlow:{title:"Bar pressure",positive:"The latest real bar closed toward its high.",negative:"The latest real bar closed toward its low."},
  breadth:{title:"Monitored-symbol breadth",positive:"More of the monitored symbols are rising together.",negative:"More of the monitored symbols are weakening together."},
  vwap:{title:"Price vs. VWAP",positive:"Price is above its recent real volume-weighted average.",negative:"Price is below its recent real volume-weighted average."}
};
