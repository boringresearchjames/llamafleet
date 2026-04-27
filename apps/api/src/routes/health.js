import express from "express";
import { now } from "../lib/utils.js";

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api", at: now() });
});

export default router;
