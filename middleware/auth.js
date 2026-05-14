import jwt from "jsonwebtoken";

export default function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).send("Login required");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).send("Invalid token");
  }
}
