import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, bootstrapSession, setAccessToken } from "@/api/client";
import type { CurrentUser } from "@/api/types";

interface LoginResult {
  accessToken: string;
  expiresIn: number;
  user: { uuid: string; nickname: string; role: string; creditScore: number; creditTier: string };
}

export const useAuthStore = defineStore("auth", () => {
  const user = ref<CurrentUser | null>(null);
  const ready = ref(false);
  const loading = ref(false);

  const isLoggedIn = computed(() => user.value !== null);
  const isModerator = computed(() => user.value?.role === "moderator" || user.value?.role === "admin");
  const isAdmin = computed(() => user.value?.role === "admin");
  const isMuted = computed(() => user.value?.status === "muted");

  async function fetchMe(): Promise<void> {
    const result = await api.get<{ user: CurrentUser }>("/auth/me");
    user.value = result.user;
  }

  // 页面刷新后用 refresh cookie 换回登录态，用户无感
  async function bootstrap(): Promise<void> {
    try {
      const restored = await bootstrapSession();
      if (restored) await fetchMe();
    } catch {
      setAccessToken(null);
      user.value = null;
    } finally {
      ready.value = true;
    }
  }

  async function login(account: string, password: string, captcha?: { id: string; code: string }) {
    loading.value = true;
    try {
      const result = await api.post<LoginResult>("/auth/login", {
        account,
        password,
        captchaId: captcha?.id,
        captchaCode: captcha?.code,
      });
      setAccessToken(result.accessToken);
      await fetchMe();
      return result;
    } finally {
      loading.value = false;
    }
  }

  async function register(input: { email?: string; phone?: string; password: string; nickname: string }) {
    loading.value = true;
    try {
      return await api.post<{ user: { uuid: string; nickname: string } }>("/auth/register", input);
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.post("/auth/logout");
    } finally {
      setAccessToken(null);
      user.value = null;
    }
  }

  async function deleteAccount(): Promise<string> {
    const result = await api.post<{ deleted: boolean; message: string }>("/me/delete-account", {
      confirm: "DELETE",
    });
    setAccessToken(null);
    user.value = null;
    return result.message;
  }

  return {
    user,
    ready,
    loading,
    isLoggedIn,
    isModerator,
    isAdmin,
    isMuted,
    bootstrap,
    fetchMe,
    login,
    register,
    logout,
    deleteAccount,
  };
});
