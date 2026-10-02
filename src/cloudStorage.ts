import { createClient } from '@supabase/supabase-js';
import type { WorkspaceState } from './workspaceStorage';

const workspaceId = 'cashbook-personal';
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabaseEnabled = Boolean(supabaseUrl && supabaseKey);
const supabase = supabaseEnabled ? createClient(supabaseUrl!, supabaseKey!) : null;

function getWorkspaceId() {
  return workspaceId;
}

export async function loadCloudWorkspace(): Promise<WorkspaceState | null> {
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from('cashbook_workspaces')
    .select('workspace_id, data, updated_at')
    .eq('workspace_id', getWorkspaceId())
    .maybeSingle();

  if (!error && data?.data) {
    return data.data as WorkspaceState;
  }

  const fallback = await supabase
    .from('cashbook_workspaces')
    .select('workspace_id, data, updated_at')
    .order('updated_at', { ascending: false });

  if (fallback.error || !fallback.data?.length) {
    return null;
  }

  const populated = [...fallback.data].sort((left, right) => {
    const leftEntries = Array.isArray((left.data as WorkspaceState)?.entries)
      ? (left.data as WorkspaceState).entries.length
      : 0;
    const rightEntries = Array.isArray((right.data as WorkspaceState)?.entries)
      ? (right.data as WorkspaceState).entries.length
      : 0;

    return rightEntries - leftEntries;
  })[0];

  return (populated?.data as WorkspaceState | undefined) ?? null;
}

export async function saveCloudWorkspace(state: WorkspaceState): Promise<boolean> {
  if (!supabase) {
    return false;
  }

  const { error } = await supabase.from('cashbook_workspaces').upsert(
    {
      workspace_id: getWorkspaceId(),
      data: state,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id' },
  );

  return !error;
}