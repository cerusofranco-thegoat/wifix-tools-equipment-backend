/* eslint-disable react-refresh/only-export-components */
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../stores/auth.store';
import { AppLayout } from '../pages/AppLayout';
import { LoginPage } from '../pages/LoginPage';
import { QueuePage } from '../pages/QueuePage';
import { SessionDetailPage } from '../pages/SessionDetailPage';
import { NotFoundPage } from '../pages/NotFoundPage';

function RequireAuth() {
  const { token } = useAuthStore();
  if (!token) return <Navigate to="/login" replace />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          {
            index: true,
            element: <Navigate to="/queue" replace />,
          },
          {
            path: 'queue',
            element: <QueuePage />,
          },
          {
            path: 'sessions/:id',
            element: <SessionDetailPage />,
          },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <NotFoundPage />,
  },
]);
