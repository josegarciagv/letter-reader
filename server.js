const express = require("express")
const multer = require("multer")
const mongoose = require("mongoose")
const path = require("path")
const fs = require("fs")
const { MongoClient } = require("mongodb")
const OpenAI = require("openai")
const stripe = require("stripe")
const crypto = require("crypto")
const pdf = require("pdf-parse")
const sharp = require("sharp")
const Tesseract = require("tesseract.js")

// Load environment variables from .env if present. When running on
// platforms like Railway the variables are provided via process.env and
// a local .env file may not exist.
const dotenvResult = require("dotenv").config()
if (dotenvResult.error) {
  console.warn("No .env file found, relying on process environment variables")
}

const app = express()
const PORT = process.env.PORT || 3000

// Initialize services
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

const stripeClient = stripe(process.env.STRIPE_SECRET_KEY)

// Support different environment variable names for the MongoDB connection.
// Railway typically provides `MONGODB_URI` for its Mongo plugin. If `MONGO_URL`
// is not defined we fall back to these alternatives.
const MONGO_URL =
  process.env.MONGO_URL || process.env.MONGODB_URI || process.env.MONGODB_URL

// Middleware
app.use(express.json({ limit: "50mb" }))
app.use(express.static("public"))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))

// Add CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")
  if (req.method === "OPTIONS") {
    res.sendStatus(200)
  } else {
    next()
  }
})

// MongoDB connection
let db
MongoClient.connect(MONGO_URL)
  .then((client) => {
    console.log("Connected to MongoDB")
    db = client.db("letterreader")
  })
  .catch((error) => {
    console.error("MongoDB connection error:", error)
    process.exit(1)
  })

// Multer configuration for file uploads
const storage = multer.memoryStorage()
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "application/pdf"]
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error("Invalid file type. Only images and PDFs are allowed."))
    }
  },
})

// Helper functions
function generateUserId(email) {
  return crypto.createHash("md5").update(email.toLowerCase()).digest("hex")
}

async function extractTextFromPDF(buffer) {
  try {
    const data = await pdf(buffer)
    return data.text
  } catch (error) {
    console.error("PDF extraction error:", error)
    throw new Error("Failed to extract text from PDF")
  }
}

async function extractTextFromImage(buffer) {
  try {
    // Convert image to a format Tesseract can handle
    const processedImage = await sharp(buffer).greyscale().normalize().png().toBuffer()

    const {
      data: { text },
    } = await Tesseract.recognize(processedImage, "eng+spa", {
      logger: (m) => console.log("OCR Progress:", m),
    })

    return text
  } catch (error) {
    console.error("OCR error:", error)
    throw new Error("Failed to extract text from image")
  }
}

async function analyzeLetterWithAI(text, language = "es") {
  try {
    // Check if OpenAI is properly configured
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OpenAI API key not configured")
    }

    const prompt =
      language === "es"
        ? `Analiza esta carta o documento y proporciona:
               1. Un resumen de lo que dice
               2. Qué acciones debe tomar el destinatario
               3. Nivel de urgencia (bajo, medio, alto)
               4. Recomendaciones específicas
               
               Texto del documento:
               ${text}`
        : `Analyze this letter or document and provide:
               1. A summary of what it says
               2. What actions the recipient should take
               3. Urgency level (low, medium, high)
               4. Specific recommendations
               
               Document text:
               ${text}`

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            language === "es"
              ? "Eres un asistente profesional que analiza cartas y documentos. Proporciona análisis claros, concisos y útiles."
              : "You are a professional assistant that analyzes letters and documents. Provide clear, concise, and useful analysis.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    })

    return response.choices[0].message.content
  } catch (error) {
    console.error("OpenAI analysis error:", error)

    // Provide a fallback analysis if OpenAI fails
    return language === "es"
      ? `Análisis del documento:
         
         Resumen: Se ha detectado contenido en el documento pero no se pudo procesar completamente con IA.
         
         Acciones recomendadas: 
         - Revisar el documento manualmente
         - Verificar si contiene información importante
         - Contactar al remitente si es necesario
         
         Nivel de urgencia: Medio
         
         Recomendaciones: Se recomienda revisar el documento original para obtener más detalles.`
      : `Document Analysis:
         
         Summary: Content detected in the document but could not be fully processed with AI.
         
         Recommended actions:
         - Review the document manually
         - Check if it contains important information
         - Contact the sender if necessary
         
         Urgency level: Medium
         
         Recommendations: It is recommended to review the original document for more details.`
  }
}

async function analyzeImageWithAI(imageBuffer, language = "es") {
  try {
    // Check if OpenAI is properly configured
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OpenAI API key not configured")
    }

    // Convert buffer to base64
    const base64Image = imageBuffer.toString("base64")

    const prompt =
      language === "es"
        ? "Analiza esta imagen de una carta o documento y proporciona: 1. Un resumen de lo que dice, 2. Qué acciones debe tomar el destinatario, 3. Nivel de urgencia, 4. Recomendaciones específicas"
        : "Analyze this image of a letter or document and provide: 1. A summary of what it says, 2. What actions the recipient should take, 3. Urgency level, 4. Specific recommendations"

    const response = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
      max_tokens: 1000,
    })

    return response.choices[0].message.content
  } catch (error) {
    console.error("OpenAI vision analysis error:", error)
    // Fallback to OCR + text analysis
    try {
      const text = await extractTextFromImage(imageBuffer)
      if (text && text.trim().length > 10) {
        return await analyzeLetterWithAI(text, language)
      } else {
        throw new Error("No readable text found in image")
      }
    } catch (ocrError) {
      console.error("OCR fallback error:", ocrError)
      return language === "es"
        ? `Análisis de imagen:
           
           Resumen: Se detectó una imagen pero no se pudo extraer texto legible.
           
           Acciones recomendadas: 
           - Verificar que la imagen sea clara y legible
           - Intentar con una imagen de mejor calidad
           - Revisar manualmente el contenido
           
           Nivel de urgencia: Bajo
           
           Recomendaciones: Subir una imagen más clara o un archivo PDF para mejores resultados.`
        : `Image Analysis:
           
           Summary: An image was detected but no readable text could be extracted.
           
           Recommended actions:
           - Verify that the image is clear and readable
           - Try with a better quality image
           - Review the content manually
           
           Urgency level: Low
           
           Recommendations: Upload a clearer image or PDF file for better results.`
    }
  }
}

// Routes

// Get user data
app.get("/api/user/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
    const userId = generateUserId(email)

    let user = await db.collection("users").findOne({ userId })

    if (!user) {
      // Create new user with 5 free tokens
      user = {
        userId,
        email,
        tokens: 5,
        createdAt: new Date(),
        totalLettersProcessed: 0,
      }
      await db.collection("users").insertOne(user)
    }

    res.json({
      email: user.email,
      tokens: user.tokens,
      totalLettersProcessed: user.totalLettersProcessed,
    })
  } catch (error) {
    console.error("Get user error:", error)
    res.status(500).json({ error: "Failed to get user data" })
  }
})

// Upload and process files
app.post("/api/upload-and-process", upload.array("files", 10), async (req, res) => {
  try {
    console.log("Processing upload request...")
    const { email, language = "es" } = req.body
    const files = req.files

    console.log("Email:", email)
    console.log("Language:", language)
    console.log("Files count:", files ? files.length : 0)

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" })
    }

    const userId = generateUserId(email)
    console.log("User ID:", userId)

    // Check user tokens
    const user = await db.collection("users").findOne({ userId })
    if (!user) {
      console.log("User not found, creating new user...")
      // Create new user with 5 free tokens
      const newUser = {
        userId,
        email,
        tokens: 5,
        createdAt: new Date(),
        totalLettersProcessed: 0,
      }
      await db.collection("users").insertOne(newUser)
      console.log("New user created")
    }

    const currentUser = await db.collection("users").findOne({ userId })
    console.log("Current user tokens:", currentUser.tokens)

    if (currentUser.tokens < files.length) {
      return res.status(400).json({
        error: `Insufficient tokens. You need ${files.length} tokens but have ${currentUser.tokens}`,
      })
    }

    const processedLetters = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      console.log(`Processing file ${i + 1}/${files.length}: ${file.originalname}`)

      try {
        let analysis

        if (file.mimetype === "application/pdf") {
          console.log("Processing PDF file...")
          const text = await extractTextFromPDF(file.buffer)
          console.log("Extracted text length:", text.length)
          analysis = await analyzeLetterWithAI(text, language)
        } else {
          console.log("Processing image file...")
          // Image file - use vision API or OCR
          analysis = await analyzeImageWithAI(file.buffer, language)
        }

        console.log("Analysis completed for:", file.originalname)

        const letter = {
          userId,
          filename: file.originalname,
          fileType: file.mimetype,
          fileSize: file.size,
          analysis,
          language,
          createdAt: new Date(),
        }

        const result = await db.collection("letters").insertOne(letter)
        processedLetters.push({
          id: result.insertedId,
          filename: file.originalname,
          analysis,
        })

        console.log("Letter saved to database:", result.insertedId)
      } catch (fileError) {
        console.error(`Error processing file ${file.originalname}:`, fileError)
        processedLetters.push({
          filename: file.originalname,
          error: fileError.message || "Failed to process file",
        })
      }
    }

    // Deduct tokens
    await db.collection("users").updateOne(
      { userId },
      {
        $inc: {
          tokens: -files.length,
          totalLettersProcessed: files.length,
        },
      },
    )

    console.log("Tokens deducted, processing complete")

    res.json({
      message: "Files processed successfully",
      processedLetters,
      remainingTokens: currentUser.tokens - files.length,
    })
  } catch (error) {
    console.error("Upload and process error:", error)
    res.status(500).json({
      error: "Failed to process files",
      details: error.message,
    })
  }
})

// Get user letters
app.get("/api/letters/:email", async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email)
    const userId = generateUserId(email)

    const letters = await db.collection("letters").find({ userId }).sort({ createdAt: -1 }).toArray()

    res.json(letters)
  } catch (error) {
    console.error("Get letters error:", error)
    res.status(500).json({ error: "Failed to get letters" })
  }
})

// Get specific letter
app.get("/api/letter/:id", async (req, res) => {
  try {
    const { ObjectId } = require("mongodb")
    const letter = await db.collection("letters").findOne({
      _id: new ObjectId(req.params.id),
    })

    if (!letter) {
      return res.status(404).json({ error: "Letter not found" })
    }

    res.json(letter)
  } catch (error) {
    console.error("Get letter error:", error)
    res.status(500).json({ error: "Failed to get letter" })
  }
})

// Delete letter
app.delete("/api/letter/:id", async (req, res) => {
  try {
    const { ObjectId } = require("mongodb")
    const result = await db.collection("letters").deleteOne({
      _id: new ObjectId(req.params.id),
    })

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Letter not found" })
    }

    res.json({ message: "Letter deleted successfully" })
  } catch (error) {
    console.error("Delete letter error:", error)
    res.status(500).json({ error: "Failed to delete letter" })
  }
})

// Create payment session
app.post("/api/create-payment", async (req, res) => {
  try {
    const { email, tokens, amount } = req.body

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${tokens} Letter Analysis Tokens`,
              description: "AI-powered letter analysis tokens for Letter Reader",
            },
            unit_amount: Math.round(amount * 100), // Convert to cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.DOMAIN}/account.html?email=${encodeURIComponent(email)}&payment=success`,
      cancel_url: `${process.env.DOMAIN}/account.html?email=${encodeURIComponent(email)}&payment=cancelled`,
      metadata: {
        email,
        tokens: tokens.toString(),
      },
    })

    res.json({ url: session.url })
  } catch (error) {
    console.error("Create payment error:", error)
    res.status(500).json({ error: "Failed to create payment session" })
  }
})

// Stripe webhook
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"]
  let event

  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object
    const { email, tokens } = session.metadata

    try {
      const userId = generateUserId(email)
      await db.collection("users").updateOne({ userId }, { $inc: { tokens: Number.parseInt(tokens) } })

      // Log the purchase
      await db.collection("purchases").insertOne({
        userId,
        email,
        tokens: Number.parseInt(tokens),
        amount: session.amount_total / 100,
        sessionId: session.id,
        createdAt: new Date(),
      })

      console.log(`Added ${tokens} tokens to user ${email}`)
    } catch (error) {
      console.error("Error processing payment webhook:", error)
    }
  }

  res.json({ received: true })
})

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() })
})

// Test endpoint for debugging
app.get("/api/test", (req, res) => {
  res.json({
    message: "Server is working",
    env: {
      mongoConnected: !!db,
      openaiConfigured: !!process.env.OPENAI_API_KEY,
      stripeConfigured: !!process.env.STRIPE_SECRET_KEY,
    },
  })
})

// Serve static files
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"))
})

app.get("/account.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "account.html"))
})

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Server error:", error)
  res.status(500).json({ error: "Internal server error", details: error.message })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" })
})

// Start server
app.listen(PORT, () => {
  console.log(`Letter Reader server running on port ${PORT}`)
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully")
  process.exit(0)
})

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully")
  process.exit(0)
})
