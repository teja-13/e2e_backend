const mongoose = require("mongoose");

const bookSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    author: {
      type: String,
      required: true,
    },
    category: {
      type: String,
    },
    isbn: {
      type: String,
      unique: true,
      required: true,
    },
    publisher: {
      type: String,
    },
    publishedYear: {
      type: Number,
    },
    language: {
      type: String,
      default: "English",
    },
    pages: {
      type: Number,
    },
    price: {
      type: Number,
      default: 0,
      min: 0,
    },
    finePerWeek: {
      type: Number,
      default: 0,
      min: 0,
    },
    copiesAvailable: {
      type: Number,
      default: 1,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Book", bookSchema);
