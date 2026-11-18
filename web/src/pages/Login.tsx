import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

const demo = [
  ["Bed Manager", "manager@bedsense.test"],
  ["ICU ward phone", "icu@bedsense.test"],
  ["Medicine ward phone", "med@bedsense.test"],
  ["Surgery ward phone", "sur@bedsense.test"],
  ["Paediatrics ward phone", "ped@bedsense.test"],
  ["Doctor (requester)", "doctor@bedsense.test"],
];

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("manager@bedsense.test");
  const [password, setPassword] = useState("bedsense123");
  const [error, setError] = useState("");

  const submit = async () => {
    try {
      const u = await login(email, password);
      nav(
        u.role === "manager"
          ? "/manager"
          : u.role === "ward"
            ? "/ward"
            : "/requests",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-3 rounded-xl bg-white p-6 shadow">
      <h1 className="text-2xl font-bold">BedSense</h1>
      <p className="text-sm text-slate-500">
        Sign in. Demo accounts use password <code>bedsense123</code>.
      </p>
      <input
        className="w-full rounded border p-2"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input
        className="w-full rounded border p-2"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        className="w-full rounded bg-slate-900 p-2 text-white"
        onClick={submit}
      >
        Sign in
      </button>
      <div className="flex flex-wrap gap-2 pt-2">
        {demo.map(([label, mail]) => (
          <button
            key={mail}
            className="rounded-full border px-3 py-1 text-xs"
            onClick={() => setEmail(mail)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
