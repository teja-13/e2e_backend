const mongoose = require("mongoose");

const registrationSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    rollNumber: String,
    branch: String,
    section: String,
    role: { type: String, enum: ["student", "librarian", "admin"], required: true },
    extra: Object,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Registration", registrationSchema);
