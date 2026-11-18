import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import type { ReactNode } from 'react';
import type { Role } from './types';
import Login from './pages/Login';
import Manager from './pages/Manager';
import Ward from './pages/Ward';
import Requester from './pages/Requester';

const home: Record<Role, string> = { manager: '/manager', ward: '/ward', requester: '/requests' };

function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={home[user.role]} replace />;
  return <>{children}</>;
}

export default function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/manager" element={<Guard role="manager"><Manager /></Guard>} />
      <Route path="/ward" element={<Guard role="ward"><Ward /></Guard>} />
      <Route path="/requests" element={<Guard role="requester"><Requester /></Guard>} />
      <Route path="*" element={<Navigate to={user ? home[user.role] : '/login'} replace />} />
    </Routes>
  );
}
