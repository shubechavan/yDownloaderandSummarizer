import mongoose from "mongoose";

const downloadSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  videoUrl: String,
  type: String,
  format: String,
  downloadedAt: { type: Date, default: Date.now }
});

export default mongoose.model("Download", downloadSchema);
