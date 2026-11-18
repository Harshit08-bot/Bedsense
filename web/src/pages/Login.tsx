// import { useState } from "react";
// import { useNavigate } from "react-router-dom";
// import { useAuth } from "../auth";

// const demo = [
//   ["Bed Manager", "manager@bedsense.test"],
//   ["ICU ward phone", "icu@bedsense.test"],
//   ["Medicine ward phone", "med@bedsense.test"],
//   ["Surgery ward phone", "sur@bedsense.test"],
//   ["Paediatrics ward phone", "ped@bedsense.test"],
//   ["Doctor (requester)", "doctor@bedsense.test"],
// ];

// export default function Login() {
//   const { login } = useAuth();
//   const nav = useNavigate();
//   const [email, setEmail] = useState("manager@bedsense.test");
//   const [password, setPassword] = useState("bedsense123");
//   const [error, setError] = useState("");

//   const submit = async () => {
//     try {
//       const u = await login(email, password);
//       nav(
//         u.role === "manager"
//           ? "/manager"
//           : u.role === "ward"
//             ? "/ward"
//             : "/requests",
//       );
//     } catch (e) {
//       setError((e as Error).message);
//     }
//   };

//   return (
//     <div className="mx-auto mt-16 max-w-sm space-y-3 rounded-xl bg-white p-6 shadow">
//       <h1 className="text-2xl font-bold">BedSense</h1>
//       <p className="text-sm text-slate-500">
//         Sign in. Demo accounts use password <code>bedsense123</code>.
//       </p>
//       <input
//         className="w-full rounded border p-2"
//         value={email}
//         onChange={(e) => setEmail(e.target.value)}
//         placeholder="Email"
//       />
//       <input
//         className="w-full rounded border p-2"
//         type="password"
//         value={password}
//         onChange={(e) => setPassword(e.target.value)}
//         placeholder="Password"
//         onKeyDown={(e) => e.key === "Enter" && submit()}
//       />
//       {error && <p className="text-sm text-red-600">{error}</p>}
//       <button
//         className="w-full rounded bg-slate-900 p-2 text-white"
//         onClick={submit}
//       >
//         Sign in
//       </button>
//       <div className="flex flex-wrap gap-2 pt-2">
//         {demo.map(([label, mail]) => (
//           <button
//             key={mail}
//             className="rounded-full border px-3 py-1 text-xs"
//             onClick={() => setEmail(mail)}
//           >
//             {label}
//           </button>
//         ))}
//       </div>
//     </div>
//   );
// }





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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-teal-50/40 to-slate-200 px-4 py-12">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200/80 bg-white/95 shadow-xl shadow-slate-200/60 backdrop-blur">
        {/* Top Accent Bar */}
        <div className="h-1.5 w-full bg-mist-500" />

        <div className="p-8">
          {/* Header & Brand */}
          <div className="mb-7 flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-600 text-white shadow-md shadow-teal-600/20">
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-black-100">
                BedSense
              </h1>
              <p className="text-xs font-medium text-teal-700">
                Hospital Bed &amp; Ward Management
              </p>
            </div>
          </div>

          <p className="mb-6 text-sm text-slate-500">
            Sign in to access your portal. Demo accounts use password{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-700">
              bedsense123
            </code>
            .
          </p>

          {/* Form Inputs */}
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
                Email Address
              </label>
              <input
                className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 transition focus:border-teal-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
                Password
              </label>
              <input
                className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 transition focus:border-teal-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-medium text-red-700">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-600" />
                <span>{error}</span>
              </div>
            )}

            <button
              className="mt-2 w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 active:scale-[0.99]"
              onClick={submit}
            >
              Sign in
            </button>
          </div>

          {/* Quick Role Switcher */}
          <div className="mt-7 border-t border-slate-100 pt-5">
            <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Quick Fill Demo Role
            </p>
            <div className="flex flex-wrap gap-2">
              {demo.map(([label, mail]) => {
                const isSelected = email === mail;
                return (
                  <button
                    key={mail}
                    type="button"
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                      isSelected
                        ? "border-teal-600 bg-teal-50 text-teal-800 shadow-xs"
                        : "border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:bg-teal-50/50 hover:text-teal-700"
                    }`}
                    onClick={() => setEmail(mail)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}








