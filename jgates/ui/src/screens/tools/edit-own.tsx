import { useMemo } from "react";
import { api } from "../../api";
import { useAsync } from "../../components/common";
import { CustomToolDialog } from "./custom-dialog";

/** The six-step dialog opened on an existing own tool; it loads what it needs (components, the other tools' names). */
export function EditOwnTool({ id, onClose }: { id: string; onClose: (saved: string | null) => void }) {
  const discovery = useAsync(() => api<{ inventory: { classifications: Array<{ id: string }> } }>("GET", "/api/workspace/discovery").catch(() => null), "edit-own-discovery");
  const tools = useAsync(() => api<{ instances: Array<{ id: string; component: string | null }> }>("GET", "/api/tools"), "edit-own-tools");
  const components = useMemo(() => {
    const ids = new Set<string>(discovery.data?.inventory.classifications.map((c) => c.id) ?? []);
    for (const i of tools.data?.instances ?? []) if (i.component) ids.add(i.component);
    return [...ids].sort();
  }, [discovery.data, tools.data]);
  if (!tools.data) return null;
  return <CustomToolDialog components={components} existing={tools.data.instances.map((i) => i.id)} edit={id} onClose={onClose} />;
}
