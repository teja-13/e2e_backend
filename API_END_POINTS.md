# Smart Library Backend API

Express + MongoDB mock auth server (`mockAuthServer.js`). Protect endpoints with JWT in the `Authorization: Bearer <token>` header unless noted as public.

## Setup
1) Copy `.env.example` to `.env` and fill `MONGODB_URI`, `JWT_SECRET`, optional `PORT`.
2) Install dependencies: `npm install`.
3) Run server: `npm start` (defaults to port 5000).

## Endpoints
- **Auth & Signup (public)**
  - POST `/student/signup` — submit student registration request.
  - POST `/librarian/signup` — submit librarian registration request.
  - POST `/admin/signup` — submit admin registration request.
  - POST `/login` — login for students/admins/librarians.

- **Registrations (admin, librarian)**
  - GET `/registrations` — list pending registrations (filter by `role`).
  - PATCH `/registrations/:id/approve` — approve a registration and create the account.
  - DELETE `/registrations/:id` — reject/remove a registration.

- **Admin (admin)**
  - POST `/admin/add-user` — add a staff or admin user directly.
  - GET `/admin/students` — list all students.
  - GET `/admin/librarians` — list all librarians.
  - POST `/admin/clear-student-borrows` — force-close active borrows, return copies, clear pending reservations.

- **Librarian (librarian/admin)**
  - GET `/librarian/students` — list all students.
  - DELETE `/librarian/students/:id` — remove a student, mark their borrows returned, free copies, and clear reservations.

- **Books & Catalog (public/student/librarian/admin)**
  - GET `/books` — list/search books (optional `q`).
  - POST `/librarian/books` — create a book (librarian/admin).

- **Reservations & Borrowing**
  - POST `/student/books/:bookId/request` — student requests a book.
  - GET `/student/reservations` — student reservations.
  - GET `/librarian/reservations` — list reservations (filter by `status`).
  - PATCH `/librarian/reservations/:id/approve` — approve a reservation, decrement copies, create borrow.
  - GET `/librarian/borrowed-active` — active borrows (filter by `studentId`/`studentEmail`).
  - PATCH `/librarian/borrowed/:id/return` — mark a borrow as returned and free a copy.

- **Student Profile & Fines (student)**
  - GET `/student/me` — profile (with fallback to token data).
  - PUT `/student/password` — change password.
  - GET `/student/borrowed` — overdue borrowed items with computed fines.
  - GET `/student/notifications` — overdue notifications.

## Conventions
- All protected routes require JWT via `Authorization: Bearer <token>`.
- Update this README whenever endpoints change or new routes are added.
