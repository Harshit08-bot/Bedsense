import { createContext, useContext, useState, type ReactNode } from "react";
import { api } from "./api";
import type { User } from "./types";

interface Ctx {
  user: User | null;
  login: (email: string, password: string) => Promise<User>;
  logout: () => void;
}
const AuthCtx = createContext<Ctx>(null!);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() =>
    JSON.parse(localStorage.getItem("user") ?? "null"),
  );
  const login = async (email: string, password: string) => {
    const r = await api<{ token: string; user: User }>("/auth/login", "POST", {
      email,
      password,
    });
    localStorage.setItem("token", r.token);
    localStorage.setItem("user", JSON.stringify(r.user));
    setUser(r.user);
    return r.user;
  };
  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
  };
  return (
    <AuthCtx.Provider value={{ user, login, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}
