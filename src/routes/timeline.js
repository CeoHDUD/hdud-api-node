// C:\HDUD_DATA\hdud-api-node\src\routes\timeline.js

import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { handleTimeline } from "../services/timeline/timeline.service.js";

const router = Router();

router.get("/", authenticate, handleTimeline);

export default router;