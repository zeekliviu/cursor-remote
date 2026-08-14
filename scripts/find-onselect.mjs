import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  defaultViewport: null,
});
const page = (await browser.pages()).find((p) =>
  p.url().includes("workbench.html"),
);

const info = await page.evaluate(() => {
  // Find an actual chat <li> row.
  const li = document.querySelector("li.ui-sidebar-menu-item");
  if (!li) return { error: "no li" };
  const fiberKey = Object.keys(li).find((k) => k.startsWith("__reactFiber$"));
  let node = li[fiberKey];
  const chain = [];
  const hits = [];
  for (let i = 0; i < 40 && node; i++) {
    const type = node.type;
    const name =
      type?.displayName ||
      type?.name ||
      (typeof type === "string" ? type : "?");
    const pending = node.pendingProps ? Object.keys(node.pendingProps) : [];
    chain.push({ i, type: name, propKeys: pending.slice(0, 30) });
    if (pending.some((k) => /select|open|switch/i.test(k) && /agent|composer|chat/i.test(k))) {
      const p = node.pendingProps;
      const relevant = {};
      for (const key of pending) {
        const v = p[key];
        if (typeof v === "function") relevant[key] = { fn: v.name || "anon", src: v.toString().slice(0, 400) };
        else if (typeof v !== "object") relevant[key] = v;
      }
      hits.push({ i, type: name, relevant });
    }
    node = node.return;
  }
  return { chain, hits };
});
console.log(JSON.stringify(info, null, 2));
await browser.disconnect();
