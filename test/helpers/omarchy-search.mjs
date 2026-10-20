// Omarchy's menu search, run on Omarchy's own code: a MenuModel.js loaded as
// the shell loads it (its functions in one scope), with the steps of
// Menu.qml's rebuildDisplay for a query typed at the root, as SUPER + SPACE
// opens it (Omarchy 4.0.4): the rows the search shows, in order. Rows of the
// root come first, each part by score, then by path; the app launchers are
// under Apps, so they come after every root row.
import { readFileSync } from "node:fs";
import vm from "node:vm";

export function loadMenuModel(path) {
  const model = vm.createContext({});
  // A QML JavaScript resource may start with .pragma or .import lines.
  vm.runInContext(readFileSync(path, "utf8").replace(/^\s*\.(pragma|import)\b.*$/gm, ""), model, { filename: path });
  return model;
}

// An installed application, as Menu.qml's mergeAppRows makes its row.
export const appRow = ({ id, name, subtext = "", keywords = [] }) => ({
  id: `apps.${id}`, parent: "apps", kind: "app", icon: "", appIcon: "", appId: id, label: name, title: "", target: "",
  description: subtext, action: "", provider: "", aliases: [...(subtext ? [subtext] : []), ...keywords], when: "", checked: "", order: 0,
});

// `defaults` and `user` are menu files' text, `apps` app rows. Every `when`
// guard counts as passed: the most rows that can compete. → the rows shown
// for `query`, each { itemId, kind, label, action, score, path }.
export function search(model, { defaults, user, apps = [] }, query) {
  const merged = model.mergeMenuSources(model.parseMenuJsonc(defaults), model.parseMenuJsonc(user));
  const { items, itemOrder } = model.mergeAppRows(merged.items, merged.itemOrder, apps);
  const current = [];
  const drilldown = [];
  for (const id of itemOrder) {
    const entry = items[id];
    if (!entry || id === "root") continue;
    if (!model.isDescendantOf(items, id, "root")) continue;
    if (!model.matchesQuery(entry, query.trim(), model.isVisible(items, itemOrder, {}, entry, 0))) continue;
    const row = model.displayRow(items, itemOrder, {}, entry, model.parentPathFor(items, id), model.searchScore(items, entry, query.trim()));
    (entry.parent === "root" ? current : drilldown).push(row);
  }
  const order = (a, b) => (a.score !== b.score ? a.score - b.score : a.path.localeCompare(b.path));
  return [...current.sort(order), ...drilldown.sort(order)].map(({ itemId, kind, label, action, score, path }) => ({ itemId, kind, label, action, score, path }));
}
