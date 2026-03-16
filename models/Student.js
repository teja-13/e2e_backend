const mongoose = require("mongoose");

const borrowedSchema = new mongoose.Schema(
  {
    book: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Book",
      required: true,
    },
    borrowedAt: {
      type: Date,
      default: Date.now,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    returned: {
      type: Boolean,
      default: false,
    },
    returnDate: {
      type: Date,
    },
    finePerWeek: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

const studentSchema = new mongoose.Schema(
  {
    studentId: {
      type: String,
      required: true,
      unique: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    name: {
      type: String,
    },
    password: {
      type: String,
      required: true,
    },
    rollNumber: {
      type: String,
    },
    branch: {
      type: String,
    },
    section: {
      type: String,
    },
    role: {
      type: String,
      default: "student",
    },
    borrowedBooks: [borrowedSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Student", studentSchema);
