const express = require("express");
const cors = require("cors");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("dotenv").config();

// Helper to enforce required environment variables and avoid in-repo secrets
const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is missing. Add it to your .env file.`);
  }
  return value;
};

const ADMIN_ID = process.env.ADMIN_ID || "admin";
const LIBRARIAN_ID = process.env.LIBRARIAN_ID || "librarian1";
const STUDENT_ID = process.env.STUDENT_ID || "student1";
const ADMIN_EMAIL = requireEnv("ADMIN_EMAIL");
const ADMIN_PASSWORD = requireEnv("ADMIN_PASSWORD");
const LIBRARIAN_EMAIL = requireEnv("LIBRARIAN_EMAIL");
const LIBRARIAN_PASSWORD = requireEnv("LIBRARIAN_PASSWORD");
const STUDENT_EMAIL = requireEnv("STUDENT_EMAIL");
const STUDENT_PASSWORD = requireEnv("STUDENT_PASSWORD");
const SECRET_KEY = requireEnv("JWT_SECRET");
const MONGODB_URI = requireEnv("MONGODB_URI");

const Book = require("./models/Book");
const Reservation = require("./models/Reservation");
const Student = require("./models/Student");
const User = require("./models/User");
const Registration = require("./models/Registration");
const Borrow = require("./models/Borrow");
const Notification = require("./models/Notification");

const app = express();
const PORT = process.env.PORT || 5000;
const USERS_FILE = "users.json";

app.use(cors());
app.use(express.json());

// Connect to MongoDB Atlas
const connectToMongo = async () => {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is missing. Add it to your .env file.");
  }

  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB Atlas");
};

// Load users from the temporary JSON file
const loadUsers = () => {
  const defaultUsers = [
    { id: ADMIN_ID, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: "admin" },
    { id: LIBRARIAN_ID, email: LIBRARIAN_EMAIL, password: LIBRARIAN_PASSWORD, role: "librarian" },
    { id: STUDENT_ID, email: STUDENT_EMAIL, password: STUDENT_PASSWORD, role: "student" },
  ];

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
  }

  const users = JSON.parse(fs.readFileSync(USERS_FILE));

  // Ensure defaults are present without duplicating
  defaultUsers.forEach((user) => {
    if (!users.find((u) => u.email === user.email)) {
      users.push(user);
    }
  });

  saveUsers(users);
  return users;
};

// Save users to the temporary JSON file
const saveUsers = (users) => {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
};

// Ensure default admin/librarian exist in Mongo for login
const ensureDefaultStaff = async () => {
  const defaults = [
    { userId: ADMIN_ID, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: "admin" },
    { userId: LIBRARIAN_ID, email: LIBRARIAN_EMAIL, password: LIBRARIAN_PASSWORD, role: "librarian" },
  ];

  for (const staff of defaults) {
    await User.updateOne(
      { $or: [{ email: staff.email }, { userId: staff.userId }] },
      { $setOnInsert: staff },
      { upsert: true }
    );
  }
};

// Ensure default student exists in Mongo so librarian views show at least one active record
const ensureDefaultStudents = async () => {
  const defaults = [
    {
      studentId: STUDENT_ID,
      email: STUDENT_EMAIL,
      password: STUDENT_PASSWORD,
      name: "Default Student",
      role: "student",
    },
  ];

  for (const student of defaults) {
    await Student.updateOne(
      { $or: [{ email: student.email }, { studentId: student.studentId }] },
      { $setOnInsert: student },
      { upsert: true }
    );
  }
};

// Middleware to authenticate and authorize users
const authenticate = (roles) => (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res
      .status(401)
      .json({ message: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    if (!roles.includes(decoded.role)) {
      return res.status(403).json({ message: "Access denied." });
    }
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: "Invalid token." });
  }
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Fine: 25% of book price per week after due date; only applies once due date has passed
const calculateFine = (dueDate, bookPrice) => {
  if (!dueDate || !bookPrice) return 0;
  const dueMs = new Date(dueDate).getTime();
  if (Number.isNaN(dueMs)) return 0;
  const now = Date.now();
  if (now <= dueMs) return 0;
  const weeksLate = Math.ceil((now - dueMs) / WEEK_MS);
  const weeklyFine = 0.25 * bookPrice;
  return weeksLate * weeklyFine;
};

// Daily notification at 11:00 for loans older than a week (not returned)
let lastNotificationDay = null;
const scheduleOverdueNotifications = () => {
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== 11 || now.getMinutes() !== 0) return;
    const todayKey = now.toISOString().slice(0, 10);
    if (lastNotificationDay === todayKey) return;
    lastNotificationDay = todayKey;

    try {
      const oneWeekAgo = new Date(Date.now() - WEEK_MS);
      const overdueBorrows = await Borrow.find({
        returned: false,
        borrowedAt: { $lte: oneWeekAgo },
      })
        .populate("student")
        .populate("book")
        .lean();

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      for (const b of overdueBorrows) {
        const target = b.student?._id;
        if (!target) continue;

        const existing = await Notification.findOne({
          student: target,
          borrow: b._id,
          createdAt: { $gte: todayStart },
        }).lean();

        if (existing) continue;

        const title = b.book?.title || "book";
        const message = `"${title}" has been borrowed for over a week. Please return it to avoid additional fines.`;

        await Notification.create({
          student: target,
          borrow: b._id,
          message,
        });

        // Still log for visibility in console
        const logTarget = b.student?.email || b.student?.studentId || "student";
        console.log(`[NOTIFY] ${logTarget}: ${message}`);
      }
    } catch (err) {
      console.error("Failed to send overdue notifications", err?.message || err);
    }
  }, 60 * 1000);
};

// Registrations listing for approval
app.get(
  "/registrations",
  authenticate(["admin", "librarian"]),
  async (req, res) => {
    try {
      const { role } = req.query;
      const filter = role ? { role } : {};
      const regs = await Registration.find(filter).sort({ createdAt: -1 }).lean();
      res.json(regs);
    } catch (error) {
      console.error("Error fetching registrations", error);
      res.status(500).json({ message: "Unable to fetch registrations" });
    }
  }
);

// Approve registration
app.patch(
  "/registrations/:id/approve",
  authenticate(["admin", "librarian"]),
  async (req, res) => {
    try {
      const reg = await Registration.findById(req.params.id);
      if (!reg) return res.status(404).json({ message: "Registration not found" });

      if (reg.role === "student") {
        const studentId = reg.rollNumber || reg.email;
        await Student.updateOne(
          { email: reg.email },
          {
            $setOnInsert: {
              studentId,
              email: reg.email,
              password: reg.password,
              name: reg.name,
              rollNumber: reg.rollNumber,
              branch: reg.branch,
              section: reg.section,
              role: "student",
            },
          },
          { upsert: true }
        );
      } else {
        const userId = reg.email;
        await User.updateOne(
          { email: reg.email },
          {
            $setOnInsert: {
              userId,
              email: reg.email,
              password: reg.password,
              name: reg.name,
              role: reg.role,
            },
          },
          { upsert: true }
        );
      }

      await Registration.findByIdAndDelete(reg._id);
      res.json({ message: "Registration approved" });
    } catch (error) {
      console.error("Error approving registration", error);
      res.status(500).json({ message: "Unable to approve registration" });
    }
  }
);

// Reject registration
app.delete(
  "/registrations/:id",
  authenticate(["admin", "librarian"]),
  async (req, res) => {
    try {
      const deleted = await Registration.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).json({ message: "Registration not found" });
      res.json({ message: "Registration removed" });
    } catch (error) {
      console.error("Error removing registration", error);
      res.status(500).json({ message: "Unable to remove registration" });
    }
  }
);

// Admin routes
app.post("/admin/add-user", authenticate(["admin"]), async (req, res) => {
  try {
    const { email, password, role } = req.body;
    const users = loadUsers();

    if (!email || !password || !role) {
      return res
        .status(400)
        .json({ message: "email, password and role are required" });
    }

    if (users.find((user) => user.email === email)) {
      return res.status(400).json({ message: "User already exists" });
    }

    const newUser = { id: `User_${users.length + 1}`, email, password, role };
    users.push(newUser);
    saveUsers(users);

    if (role === "admin" || role === "librarian") {
      await User.updateOne(
        { email },
        {
          $setOnInsert: {
            userId: newUser.id,
            email,
            password,
            role,
          },
        },
        { upsert: true }
      );
    }

    res.status(201).json({ message: "User added successfully" });
  } catch (error) {
    console.error("Error adding user", error);
    res.status(500).json({ message: "Unable to add user" });
  }
});

// List all students (admin only)
app.get("/admin/students", authenticate(["admin"]), async (req, res) => {
  try {
    const students = await Student.find({}).lean();
    res.json(students);
  } catch (error) {
    console.error("Error fetching students", error);
    res.status(500).json({ message: "Unable to fetch students" });
  }
});

// List students (librarian/admin)
app.get("/librarian/students", authenticate(["librarian", "admin"]), async (req, res) => {
  try {
    const students = await Student.find({}).lean();
    res.json(students);
  } catch (error) {
    console.error("Error fetching students", error);
    res.status(500).json({ message: "Unable to fetch students" });
  }
});

// Delete a student profile and return all their books
app.delete("/librarian/students/:id", authenticate(["librarian", "admin"]), async (req, res) => {
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return res.status(404).json({ message: "Student not found" });

    // Return active borrows
    const borrows = await Borrow.find({ student: student._id, returned: false }).populate("book");
    for (const b of borrows) {
      if (b.book) {
        await Book.updateOne({ _id: b.book._id }, { $inc: { copiesAvailable: 1 } });
      }
      b.returned = true;
      b.returnDate = new Date();
      await b.save();
    }

    // Clean reservations (pending/approved) for this student
    await Reservation.deleteMany({ studentId: student.studentId });

    // Clear embedded borrowedBooks for this student
    await Student.updateOne({ _id: student._id }, { $set: { borrowedBooks: [] } });

    // Finally remove student record
    await Student.deleteOne({ _id: student._id });

    res.json({ message: "Student removed and books returned" });
  } catch (error) {
    console.error("Error deleting student", error);
    res.status(500).json({ message: "Unable to delete student" });
  }
});

// List all librarians
app.get("/admin/librarians", authenticate(["admin"]), async (req, res) => {
  try {
    const librarians = await User.find({ role: "librarian" }).lean();
    res.json(librarians);
  } catch (error) {
    console.error("Error fetching librarians", error);
    res.status(500).json({ message: "Unable to fetch librarians" });
  }
});

// Delete a librarian (admin only)
app.delete("/admin/librarians/:id", authenticate(["admin"]), async (req, res) => {
  try {
    const { id } = req.params;
    const librarian = await User.findOne({ $or: [{ _id: id }, { userId: id }] });
    if (!librarian) {
      return res.status(404).json({ message: "Librarian not found" });
    }

    await User.deleteOne({ _id: librarian._id });

    // Clean up any pending registration with same email
    if (librarian.email) {
      await Registration.deleteMany({ email: librarian.email });
    }

    res.json({ message: "Librarian removed" });
  } catch (error) {
    console.error("Error deleting librarian", error);
    res.status(500).json({ message: "Unable to delete librarian" });
  }
});

// Admin utility: clear all student borrowed data and pending/approved reservations
app.post(
  "/admin/clear-student-borrows",
  authenticate(["admin"]),
  async (req, res) => {
    try {
      const activeBorrows = await Borrow.find({ returned: false }).populate("book").populate("student");

      for (const b of activeBorrows) {
        if (b.book) {
          await Book.updateOne({ _id: b.book._id }, { $inc: { copiesAvailable: 1 } });
        }

        if (b.student && b.book) {
          await Reservation.deleteOne({
            studentId: b.student.studentId,
            book: b.book._id,
          });
        }

        b.returned = true;
        b.returnDate = new Date();
        await b.save();
      }

      await Student.updateMany({}, { $set: { borrowedBooks: [] } });
      const removedReservations = await Reservation.deleteMany({ status: { $in: ["pending", "approved"] } });

      res.json({
        message: "Cleared borrowed data and pending approvals",
        borrowsClosed: activeBorrows.length,
        reservationsDeleted: removedReservations.deletedCount,
      });
    } catch (error) {
      console.error("Error clearing student borrows", error);
      res.status(500).json({ message: "Unable to clear student borrows" });
    }
  }
);

// Book catalog (public/student/librarian)
app.get("/books", async (req, res) => {
  try {
    const { q } = req.query;
    const search = q
      ? {
          title: { $regex: q, $options: "i" },
        }
      : {};

    const books = await Book.find(search).limit(50).lean();
    res.json(books);
  } catch (error) {
    console.error("Error fetching books", error);
    res.status(500).json({ message: "Unable to fetch books" });
  }
});

// Student routes
app.post(
  "/student/books/:bookId/request",
  authenticate(["student"]),
  async (req, res) => {
    try {
      const { bookId } = req.params;
      const book = await Book.findById(bookId);

      if (!book) {
        return res.status(404).json({ message: "Book not found" });
      }

      if (book.copiesAvailable <= 0) {
        return res.status(400).json({ message: "No copies available" });
      }

      const reservation = await Reservation.create({
        book: book._id,
        studentId: req.user.id,
        studentEmail: req.user.email,
      });

      res
        .status(201)
        .json({
          message: "Request submitted. Awaiting librarian approval.",
          reservationId: reservation._id,
        });
    } catch (error) {
      console.error("Error creating reservation", error);
      res.status(500).json({ message: "Unable to request book" });
    }
  }
);

// Student profile
app.get(
  "/student/me",
  authenticate(["student"]),
  async (req, res) => {
    try {
      const student = await Student.findOne({ studentId: req.user.id }).lean();
      if (!student) {
        // Fallback to token data so profile still shows something even if student doc is missing
        return res.json({
          name: req.user.name || undefined,
          email: req.user.email,
          studentId: req.user.id,
        });
      }
      res.json({
        name: student.name,
        email: student.email,
        studentId: student.studentId,
        rollNumber: student.rollNumber,
        branch: student.branch,
        section: student.section,
      });
    } catch (error) {
      console.error("Error fetching student profile", error);
      res.status(500).json({ message: "Unable to fetch profile" });
    }
  }
);

// Student change password
app.put(
  "/student/password",
  authenticate(["student"]),
  async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current and new passwords are required" });
      }

      const student = await Student.findOne({ studentId: req.user.id });
      if (!student) return res.status(404).json({ message: "Student not found" });

      if (student.password !== currentPassword) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }

      student.password = newPassword;
      await student.save();

      res.json({ message: "Password updated" });
    } catch (error) {
      console.error("Error updating student password", error);
      res.status(500).json({ message: "Unable to update password" });
    }
  }
);

// Admin reset student password (no old password required)
app.put(
  "/admin/students/:id/password",
  authenticate(["admin"]),
  async (req, res) => {
    try {
      const { newPassword } = req.body || {};
      if (!newPassword) {
        return res.status(400).json({ message: "newPassword is required" });
      }

      const student = await Student.findOne({ $or: [{ _id: req.params.id }, { studentId: req.params.id }] });
      if (!student) return res.status(404).json({ message: "Student not found" });

      student.password = newPassword;
      await student.save();

      res.json({ message: "Student password reset" });
    } catch (error) {
      console.error("Error resetting student password", error);
      res.status(500).json({ message: "Unable to reset password" });
    }
  }
);

// Admin reset librarian password (no old password required)
app.put(
  "/admin/librarians/:id/password",
  authenticate(["admin"]),
  async (req, res) => {
    try {
      const { newPassword } = req.body || {};
      if (!newPassword) {
        return res.status(400).json({ message: "newPassword is required" });
      }

      const librarian = await User.findOne({ $or: [{ _id: req.params.id }, { userId: req.params.id }, { email: req.params.id }], role: "librarian" });
      if (!librarian) return res.status(404).json({ message: "Librarian not found" });

      librarian.password = newPassword;
      await librarian.save();

      res.json({ message: "Librarian password reset" });
    } catch (error) {
      console.error("Error resetting librarian password", error);
      res.status(500).json({ message: "Unable to reset password" });
    }
  }
);

// Librarian reset student password (no old password required)
app.put(
  "/librarian/students/:id/password",
  authenticate(["librarian"]),
  async (req, res) => {
    try {
      const { newPassword } = req.body || {};
      if (!newPassword) {
        return res.status(400).json({ message: "newPassword is required" });
      }

      const student = await Student.findOne({ $or: [{ _id: req.params.id }, { studentId: req.params.id }] });
      if (!student) return res.status(404).json({ message: "Student not found" });

      student.password = newPassword;
      await student.save();

      res.json({ message: "Student password reset" });
    } catch (error) {
      console.error("Error resetting student password (librarian)", error);
      res.status(500).json({ message: "Unable to reset password" });
    }
  }
);

// Admin analytics summary
app.get("/admin/analytics/summary", authenticate(["admin"]), async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(now);
    start.setMonth(start.getMonth() - 5, 1);
    start.setHours(0, 0, 0, 0);

    const [
      totalBooks,
      availableCopiesAgg,
      totalReservations,
      pendingReservations,
      approvedReservations,
      totalStudents,
      totalStaff,
      activeBorrowed,
      overdueBorrowed,
      topBorrowed,
      borrowTrend,
      overdueRows,
      activity,
    ] = await Promise.all([
      Book.countDocuments({}),
      Book.aggregate([{ $group: { _id: null, value: { $sum: "$copiesAvailable" } } }]),
      Reservation.countDocuments({}),
      Reservation.countDocuments({ status: "pending" }),
      Reservation.countDocuments({ status: "approved" }),
      Student.countDocuments({}),
      User.countDocuments({ role: { $in: ["admin", "librarian"] } }),
      Borrow.countDocuments({ returned: false }),
      Borrow.countDocuments({ returned: false, dueDate: { $lt: new Date() } }),
      Borrow.aggregate([
        { $group: { _id: "$book", borrows: { $sum: 1 } } },
        { $sort: { borrows: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: "books",
            localField: "_id",
            foreignField: "_id",
            as: "book",
          },
        },
        { $unwind: { path: "$book", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            title: { $ifNull: ["$book.title", "Unknown"] },
            borrows: 1,
          },
        },
      ]),
      Borrow.aggregate([
        { $match: { borrowedAt: { $gte: start } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$borrowedAt" } },
            borrows: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Borrow.find({ returned: false, dueDate: { $lt: new Date() } })
        .populate("book")
        .populate("student")
        .sort({ dueDate: 1 })
        .limit(5)
        .lean(),
      Notification.find({})
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),
    ]);

    const availabilityAgg = availableCopiesAgg?.[0]?.value || 0;

    const overdueRowsFormatted = (overdueRows || []).map((o) => ({
      title: o.book?.title || "Unknown",
      borrower: o.student?.email || o.student?.studentId || "student",
      dueDate: o.dueDate ? new Date(o.dueDate).toISOString().slice(0, 10) : "-",
      daysOverdue: o.dueDate ? Math.ceil((Date.now() - new Date(o.dueDate).getTime()) / (1000 * 60 * 60 * 24)) : 0,
      fineDue: calculateFine(o.dueDate, o.book?.price),
    }));

    const activityFormatted = (activity || []).map((a) => ({
      message: a.message,
      time: a.createdAt ? new Date(a.createdAt).toISOString() : "",
    }));

    res.json({
      metrics: {
        totalBooks,
        availableCopies: availabilityAgg,
        totalReservations,
        pendingReservations,
        approvedReservations,
        totalStudents,
        totalStaff,
        activeBorrowed,
        overdueBorrowed,
      },
      topBooks: topBorrowed,
      borrowTrend: borrowTrend.map((b) => ({ month: b._id, borrows: b.borrows })),
      overdue: overdueRowsFormatted,
      activity: activityFormatted,
    });
  } catch (error) {
    console.error("Error building admin analytics summary", error);
    res.status(500).json({ message: "Unable to fetch analytics" });
  }
});

app.get(
  "/student/reservations",
  authenticate(["student"]),
  async (req, res) => {
    try {
      const reservations = await Reservation.find({
        studentId: req.user.id,
      })
        .populate("book")
        .lean();

      res.json(reservations);
    } catch (error) {
      console.error("Error fetching student reservations", error);
      res.status(500).json({ message: "Unable to fetch reservations" });
    }
  }
);

app.get(
  "/student/borrowed",
  authenticate(["student"]),
  async (req, res) => {
    try {
      const student = await Student.findOne({ studentId: req.user.id })
        .populate("borrowedBooks.book")
        .lean();

      if (!student) {
        return res.json([]);
      }

      const active = (student.borrowedBooks || []).filter((entry) => entry.returned !== true);

      const overdue = active
        .map((entry) => {
          const price = entry.book?.price || 0;
          return {
            ...entry,
            fineDue: calculateFine(entry.dueDate, price),
          };
        })
        .filter((b) => (b.fineDue || 0) > 0);

      res.json(overdue);
    } catch (error) {
      console.error("Error fetching borrowed books", error);
      res.status(500).json({ message: "Unable to fetch borrowed books" });
    }
  }
);

// Student notifications
app.get(
  "/student/notifications",
  authenticate(["student"]),
  async (req, res) => {
    try {
      const studentDoc = await Student.findOne({ studentId: req.user.id }).lean();
      if (!studentDoc) return res.json([]);

      const notices = await Notification.find({ student: studentDoc._id })
        .sort({ createdAt: -1 })
        .lean();
      res.json(notices);
    } catch (error) {
      console.error("Error fetching notifications", error);
      res.status(500).json({ message: "Unable to fetch notifications" });
    }
  }
);

// Mark notification as read (and keep it visible to caller if needed)
app.patch(
  "/student/notifications/:id/read",
  authenticate(["student"]),
  async (req, res) => {
    try {
      const studentDoc = await Student.findOne({ studentId: req.user.id }).lean();
      if (!studentDoc) return res.status(404).json({ message: "Student not found" });

      const updated = await Notification.findOneAndUpdate(
        { _id: req.params.id, student: studentDoc._id },
        { $set: { read: true } },
        { new: true }
      ).lean();

      if (!updated) return res.status(404).json({ message: "Notification not found" });

      res.json(updated);
    } catch (error) {
      console.error("Error marking notification read", error);
      res.status(500).json({ message: "Unable to update notification" });
    }
  }
);

// Librarian routes
app.get(
  "/librarian/reservations",
  authenticate(["librarian"]),
  async (req, res) => {
    try {
      const { status } = req.query;
      const filters = status ? { status } : {};

      const reservations = await Reservation.find(filters)
        .populate("book")
        .lean();

      res.json(reservations);
    } catch (error) {
      console.error("Error fetching reservations", error);
      res.status(500).json({ message: "Unable to fetch reservations" });
    }
  }
);

// Active borrowed books list for librarian
app.get(
  "/librarian/borrowed-active",
  authenticate(["librarian"]),
  async (req, res) => {
    try {
      const { studentId, studentEmail } = req.query;

      const borrows = await Borrow.find({ returned: false })
        .populate("book")
        .populate("student")
        .lean();

      const filtered = borrows.filter((b) => {
        if (studentId && b.student?.studentId !== studentId) return false;
        if (studentEmail && b.student?.email !== studentEmail) return false;
        return true;
      });

      res.json(filtered);
    } catch (error) {
      console.error("Error fetching active borrows", error);
      res.status(500).json({ message: "Unable to fetch borrowed books" });
    }
  }
);

app.post(
  "/librarian/books",
  authenticate(["librarian", "admin"]),
  async (req, res) => {
    try {
      const { title, author, isbn } = req.body;

      if (!title || !author || !isbn) {
        return res
          .status(400)
          .json({ message: "title, author, and isbn are required" });
      }

      const book = await Book.create({ ...req.body });
      res.status(201).json(book);
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(400).json({ message: "ISBN already exists" });
      }
      console.error("Error creating book", error);
      res.status(500).json({ message: "Unable to create book" });
    }
  }
);

app.patch(
  "/librarian/reservations/:id/approve",
  authenticate(["librarian"]),
  async (req, res) => {
    try {
      const reservation = await Reservation.findById(req.params.id).populate(
        "book"
      );

      if (!reservation) {
        return res.status(404).json({ message: "Reservation not found" });
      }

      if (reservation.status !== "pending") {
        return res.status(400).json({ message: "Reservation already handled" });
      }

      if (!reservation.book || reservation.book.copiesAvailable <= 0) {
        return res.status(400).json({ message: "No copies available" });
      }

      // decrement copies atomically to avoid race conditions
      const updatedBook = await Book.findOneAndUpdate(
        { _id: reservation.book._id, copiesAvailable: { $gt: 0 } },
        { $inc: { copiesAvailable: -1 } },
        { new: true }
      );

      if (!updatedBook) {
        return res.status(400).json({ message: "No copies available" });
      }

      reservation.status = "approved";
      reservation.approvedAt = new Date();

      const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const finePerWeek = updatedBook.finePerWeek || 0;

      const student = await Student.findOneAndUpdate(
        { studentId: reservation.studentId },
        {
          $setOnInsert: {
            studentId: reservation.studentId,
            email: reservation.studentEmail,
          },
          $push: {
            borrowedBooks: {
              book: updatedBook._id,
              borrowedAt: new Date(),
              dueDate,
              finePerWeek,
            },
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Capture borrow record
      let issuer = null;
      if (req.user?.email) {
        issuer = await User.findOne({ email: req.user.email });
      }

      await Borrow.create({
        book: updatedBook._id,
        student: student?._id,
        issuedBy: issuer?._id,
        borrowedAt: new Date(),
        dueDate,
        fineAmount: 0,
      });

      await reservation.save();

      res.json({ message: "Reservation approved", dueDate, finePerWeek });
    } catch (error) {
      console.error("Error approving reservation", error);
      res.status(500).json({ message: "Unable to approve reservation" });
    }
  }
);

// Mark a borrowed book as returned
app.patch(
  "/librarian/borrowed/:id/return",
  authenticate(["librarian"]),
  async (req, res) => {
    try {
      const borrow = await Borrow.findById(req.params.id).populate("book").populate("student");
      if (!borrow) return res.status(404).json({ message: "Borrow record not found" });
      if (borrow.returned) return res.status(400).json({ message: "Already returned" });

      // increment copies atomically
      if (borrow.book) {
        await Book.updateOne({ _id: borrow.book._id }, { $inc: { copiesAvailable: 1 } });
      }

      // update student embedded borrowedBooks
      if (borrow.student) {
        await Student.updateOne(
          { _id: borrow.student._id },
          {
            $set: {
              "borrowedBooks.$[b].returned": true,
              "borrowedBooks.$[b].returnDate": new Date(),
            },
          },
          {
            arrayFilters: [
              { "b.book": borrow.book?._id, "b.returned": false },
            ],
          }
        );
      }

      // update reservation status to returned
      if (borrow.student && borrow.book) {
        await Reservation.updateOne(
          {
            studentId: borrow.student.studentId,
            book: borrow.book._id,
            status: "approved",
          },
          { $set: { status: "returned" } }
        );

        // remove the reservation record to keep list clean
        await Reservation.deleteOne({
          studentId: borrow.student.studentId,
          book: borrow.book._id,
          status: "returned",
        });
      }

      borrow.returned = true;
      borrow.returnDate = new Date();
      await borrow.save();

      res.json({ message: "Book marked as returned" });
    } catch (error) {
      console.error("Error marking return", error);
      res.status(500).json({ message: "Unable to mark as returned" });
    }
  }
);

// Common routes
app.post("/student/signup", async (req, res) => {
  try {
    const { name, email, password, rollNumber, branch, section } = req.body;

    if (!email || !password || !rollNumber) {
      return res
        .status(400)
        .json({ message: "email, password, and rollNumber are required" });
    }

    const studentId = rollNumber;

    const existingStudent = await Student.findOne({ $or: [{ email }, { studentId }] });
    const existingReg = await Registration.findOne({ email });
    if (existingStudent || existingReg) {
      return res.status(400).json({ message: "Student already exists or pending" });
    }

    await Registration.create({
      name,
      email,
      password,
      rollNumber,
      branch,
      section,
      role: "student",
    });

    res.status(201).json({ message: "Signup request submitted for approval" });
  } catch (error) {
    console.error("Error creating student", error);
    res.status(500).json({ message: "Unable to sign up student" });
  }
});

app.post("/librarian/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "email and password are required" });
    }

    const existingUser = await User.findOne({ email });
    const existingReg = await Registration.findOne({ email });
    if (existingUser || existingReg) {
      return res.status(400).json({ message: "User already exists or pending" });
    }

    await Registration.create({ email, password, name, role: "librarian" });
    res.status(201).json({ message: "Librarian signup submitted for approval" });
  } catch (error) {
    console.error("Error creating librarian", error);
    res.status(500).json({ message: "Unable to create librarian" });
  }
});

app.post("/admin/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "email and password are required" });
    }

    const existingUser = await User.findOne({ email });
    const existingReg = await Registration.findOne({ email });
    if (existingUser || existingReg) {
      return res.status(400).json({ message: "User already exists or pending" });
    }

    await Registration.create({ email, password, name, role: "admin" });
    res.status(201).json({ message: "Admin signup submitted for approval" });
  } catch (error) {
    console.error("Error creating admin", error);
    res.status(500).json({ message: "Unable to create admin" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check MongoDB students first
    const student = await Student.findOne({ email });
    if (student && student.password === password) {
      const token = jwt.sign(
        { id: student.studentId, email: student.email, role: "student" },
        SECRET_KEY,
        { expiresIn: "1h" }
      );
      return res
        .status(200)
        .json({ message: "Success", token, role: "student" });
    }

    // Check MongoDB staff (admin/librarian)
    const staff = await User.findOne({ email });
    if (staff && staff.password === password) {
      const token = jwt.sign(
        { id: staff.userId, email: staff.email, role: staff.role },
        SECRET_KEY,
        { expiresIn: "1h" }
      );
      return res
        .status(200)
        .json({ message: "Success", token, role: staff.role });
    }

    // Fallback to seeded JSON users
    const users = loadUsers();
    const user = users.find((u) => u.email === email && u.password === password);

    if (user) {
      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        SECRET_KEY,
        {
          expiresIn: "1h",
        }
      );
      return res.status(200).json({ message: "Success", token, role: user.role });
    }

    return res.status(401).json({ message: "Invalid email or password" });
  } catch (error) {
    console.error("Login error", error);
    res.status(500).json({ message: "Unable to login" });
  }
});

const start = async () => {
  try {
    await connectToMongo();
    await ensureDefaultStaff();
    await ensureDefaultStudents();
    scheduleOverdueNotifications();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server", error.message);
    process.exit(1);
  }
};

start();