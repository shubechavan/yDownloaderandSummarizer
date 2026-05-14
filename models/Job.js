import mongoose from "mongoose";

const jobSchema = new mongoose.Schema({
  jobId:       { type: String, required: true, unique: true, index: true },
  status:      { type: String, enum: ["pending", "done", "failed"], default: "pending" },
  downloadUrl: String,
  ext:         String,
  error:       String,
  createdAt:   { type: Date, default: Date.now, expires: 3600 }, // auto-delete after 1 hour
});

export default mongoose.model("Job", jobSchema);
