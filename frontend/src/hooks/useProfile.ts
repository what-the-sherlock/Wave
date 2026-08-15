import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { axiosInstance } from "../lib/axios";
import { extractErrorMessage } from "../lib/utils";
import { useSession } from "./useSession";

export type Profile = {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  timezone: string;
};

export type UpdateProfileInput = Partial<Pick<Profile, "fullName" | "timezone">>;

async function fetchProfile(): Promise<Profile> {
  const res = await axiosInstance.get<Profile>("/profile/me");
  return res.data;
}

async function updateProfile(patch: UpdateProfileInput): Promise<Profile> {
  const res = await axiosInstance.put<Profile>("/profile/me", patch);
  return res.data;
}

export function useProfile() {
  const { data: session } = useSession();
  return useQuery({
    queryKey: ["profile"],
    queryFn: fetchProfile,
    enabled: Boolean(session?.id),
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateProfile,
    onSuccess: (profile) => {
      queryClient.setQueryData(["profile"], profile);
      toast.success("Profile updated");
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error));
    },
  });
}
