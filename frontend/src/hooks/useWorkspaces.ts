import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { axiosInstance } from "../lib/axios";
import { extractErrorMessage } from "../lib/utils";
import { useSession } from "./useSession";
import type {
  CreatedInvite,
  Invite,
  InvitePreview,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceSettings,
} from "../types/workspace";

async function fetchWorkspaces(): Promise<Workspace[]> {
  const res = await axiosInstance.get<Workspace[]>("/workspaces");
  return res.data;
}

async function fetchWorkspaceBySlug(slug: string): Promise<Workspace> {
  const res = await axiosInstance.get<Workspace>(`/workspaces/by-slug/${slug}`);
  return res.data;
}

export function useWorkspaces() {
  const { data: session } = useSession();
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: fetchWorkspaces,
    enabled: Boolean(session?.id),
  });
}

export function useWorkspaceBySlug(slug: string | undefined) {
  const { data: session } = useSession();
  return useQuery({
    queryKey: ["workspace", slug],
    queryFn: () => fetchWorkspaceBySlug(slug!),
    enabled: Boolean(session?.id) && Boolean(slug),
    retry: false,
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await axiosInstance.post<Workspace>("/workspaces", { name });
      return res.data;
    },
    onSuccess: (workspace) => {
      queryClient.setQueryData(["workspace", workspace.slug], workspace);
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success(`${workspace.name} created`);
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export type UpdateWorkspaceInput = {
  workspaceId: string;
  slug: string;
  patch: { name?: string; iconUrl?: string | null; settings?: Partial<WorkspaceSettings> };
};

export function useUpdateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ workspaceId, patch }: UpdateWorkspaceInput) => {
      const res = await axiosInstance.patch<Workspace>(`/workspaces/${workspaceId}`, patch);
      return res.data;
    },
    onSuccess: (workspace, variables) => {
      queryClient.setQueryData(["workspace", variables.slug], workspace);
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success("Workspace updated");
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

async function fetchMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const res = await axiosInstance.get<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  return res.data;
}

export function useWorkspaceMembers(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["workspace-members", workspaceId],
    queryFn: () => fetchMembers(workspaceId!),
    enabled: Boolean(workspaceId),
  });
}

export function useUpdateMemberRole(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: WorkspaceRole }) => {
      await axiosInstance.patch(`/workspaces/${workspaceId}/members/${userId}`, { role });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
      toast.success("Role updated");
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useRemoveMember(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await axiosInstance.delete(`/workspaces/${workspaceId}/members/${userId}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      toast.success("Member removed");
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useLeaveWorkspace(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await axiosInstance.delete(`/workspaces/${workspaceId}/members/me`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success("You left the workspace");
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

async function fetchInvites(workspaceId: string): Promise<Invite[]> {
  const res = await axiosInstance.get<Invite[]>(`/workspaces/${workspaceId}/invites`);
  return res.data;
}

export function useInvites(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["workspace-invites", workspaceId],
    queryFn: () => fetchInvites(workspaceId!),
    enabled: Boolean(workspaceId),
  });
}

export type CreateInviteInput = {
  email?: string;
  role: WorkspaceRole;
  maxUses?: number;
  expiresInDays?: number;
};

export function useCreateInvite(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInviteInput) => {
      const res = await axiosInstance.post<CreatedInvite>(
        `/workspaces/${workspaceId}/invites`,
        input,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspace-invites", workspaceId] });
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useRevokeInvite(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      await axiosInstance.delete(`/workspaces/${workspaceId}/invites/${inviteId}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspace-invites", workspaceId] });
      toast.success("Invite revoked");
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useInvitePreview(token: string | undefined) {
  const { data: session } = useSession();
  return useQuery({
    queryKey: ["invite-preview", token],
    queryFn: async () => {
      const res = await axiosInstance.get<InvitePreview>(`/invites/${token}`);
      return res.data;
    },
    enabled: Boolean(session?.id) && Boolean(token),
    retry: false,
  });
}

export function useAcceptInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) => {
      const res = await axiosInstance.post<{ workspaceId: string; role: WorkspaceRole }>(
        `/invites/${token}/accept`,
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      toast.success("Invite accepted");
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}
