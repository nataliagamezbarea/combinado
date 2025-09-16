import fetch from "node-fetch";

export const config = {
  schedule: "0 0 * * 0", 
};

export default async function handler(req, res) {
  try {
    const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:3000`;

    const response = await fetch(`${baseUrl}/google-calendar/create-watch`);
    const data = await response.json();

    console.log("✅ Canal renovado:", data);
    res.status(200).json(data);
  } catch (error) {
    console.error("❌ Error llamando a create-watch:", error);
    res.status(500).json({ error: error.message });
  }
}
