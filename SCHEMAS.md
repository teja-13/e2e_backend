# Database Schemas

## Book (models/Book.js)
```js
{
  title: String (required),
  author: String (required),
  category: String,
  isbn: String (required, unique),
  publisher: String,
  publishedYear: Number,
  language: String (default: "English"),
  pages: Number,
  price: Number (default: 0, min: 0),
  finePerWeek: Number (default: 0, min: 0),
  copiesAvailable: Number (default: 1)
}
```

## Reservation (models/Reservation.js)
```js
{
  book: ObjectId -> Book (required),
  studentId: String (required),
  studentEmail: String,
  status: "pending" | "approved" | "rejected" (default: "pending"),
  approvedAt: Date
}
```

## Borrow (models/Borrow.js)
```js
{
  book: ObjectId -> Book (required),
  student: ObjectId -> Student (required),
  issuedBy: ObjectId -> User, // librarian/admin
  borrowedAt: Date (default: now),
  dueDate: Date (required),
  returned: Boolean (default: false),
  returnDate: Date,
  fineAmount: Number (default: 0)
}
```

## Student (models/Student.js)
```js
{
  studentId: String (required, unique),
  email: String (required, unique),
  password: String (required),
  name: String,
  rollNumber: String,
  branch: String,
  section: String,
  role: String (default: "student"),
  borrowedBooks: [
    {
      book: ObjectId -> Book (required),
      borrowedAt: Date (default: now),
      dueDate: Date (required),
      returned: Boolean (default: false),
      returnDate: Date,
      finePerWeek: Number (default: 0, min: 0)
    }
  ],
  // no auto timestamp fields listed
}
```

## User (models/User.js) — Admin/Librarian
```js
{
  userId: String (required, unique),
  email: String (required, unique),
  password: String (required),
  name: String,
  role: "admin" | "librarian" (required, enum)
}
```

## Registration (models/Registration.js)
```js
{
  name: String,
  email: String (required, unique),
  password: String (required),
  rollNumber: String,
  branch: String,
  section: String,
  role: "student" | "librarian" | "admin" (required, enum),
  extra: Object
}
```

## Notification (models/Notification.js)
```js
{
  student: ObjectId -> Student (required),
  borrow: ObjectId -> Borrow (required),
  message: String (required),
  read: Boolean (default: false)
}
```
