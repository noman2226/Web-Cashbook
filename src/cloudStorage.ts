import { createClient } from '@supabase/supabase-js';
import type { WorkspaceState } from './workspaceStorage';

const workspaceIdKey = 'cashbook-local.supabase-workspace-id';
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabaseEnabled = Boolean(supabaseUrl && supabaseKey);
const supabase = supabaseEnabled ? createClient(supabaseUrl!, supabaseKey!) : null;

function getWorkspaceId() {
  const existingId = window.localStorage.getItem(workspaceIdKey);
  if (existingId) {
    return existingId;
  }

  const nextId = crypto.randomUUID();
  window.localStorage.setItem(workspaceIdKey, nextId);
  return nextId;
}

export async function loadCloudWorkspace(): Promise<WorkspaceState | null> {
  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from('cashbook_workspaces')
    .select('data')
    .eq('workspace_id', getWorkspaceId())
    .maybeSingle();

  if (error || !data?.data) {
    return null;
  }

  return data.data as WorkspaceState;
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