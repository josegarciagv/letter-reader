const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');
const OpenAI = require('openai');
const stripe = require('stripe');
const crypto = require('crypto');
const pdf = require('pdf-parse');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize services
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// MongoDB connection
let db;
MongoClient.connect(process.env.MONGO_URL, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(client => {
    console.log('Connected to MongoDB');
    db = client.db('letterreader');
}).catch(error => {
    console.error('MongoDB connection error:', error);
    process.exit(1);
});

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only images and PDFs are allowed.'));
        }
    }
});

// Helper functions
function generateUserId(email) {
    return crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
}

async function extractTextFromPDF(buffer) {
    try {
        const data = await pdf(buffer);
        return data.text;
    } catch (error) {
        console.error('PDF extraction error:', error);
        throw new Error('Failed to extract text from PDF');
    }
}

async function extractTextFromImage(buffer) {
    try {
        // Convert image to a format Tesseract can handle
        const processedImage = await sharp(buffer)
            .greyscale()
            .normalize()
            .png()
            .toBuffer();

        const { data: { text } } = await Tesseract.recognize(processedImage, 'eng+spa', {
            logger: m => console.log(m)
        });
        
        return text;
    } catch (error) {
        console.error('OCR error:', error);
        throw new Error('Failed to extract text from image');
    }
}

async function analyzeLetterWithAI(text, language = 'es') {
    try {
        const prompt = language === 'es' 
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
               ${text}`;

        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: language === 'es' 
                        ? "Eres un asistente profesional que analiza cartas y documentos. Proporciona análisis claros, concisos y útiles."
                        : "You are a professional assistant that analyzes letters and documents. Provide clear, concise, and useful analysis."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            max_tokens: 1000,
            temperature: 0.7
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI analysis error:', error);
        throw new Error('Failed to analyze letter with AI');
    }
}

async function analyzeImageWithAI(imageBuffer, language = 'es') {
    try {
        // Convert buffer to base64
        const base64Image = imageBuffer.toString('base64');
        
        const prompt = language === 'es' 
            ? "Analiza esta imagen de una carta o documento y proporciona: 1. Un resumen de lo que dice, 2. Qué acciones debe tomar el destinatario, 3. Nivel de urgencia, 4. Recomendaciones específicas"
            : "Analyze this image of a letter or document and provide: 1. A summary of what it says, 2. What actions the recipient should take, 3. Urgency level, 4. Specific recommendations";

        const response = await openai.chat.completions.create({
            model: "gpt-4-vision-preview",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: prompt
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${base64Image}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1000
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI vision analysis error:', error);
        // Fallback to OCR + text analysis
        const text = await extractTextFromImage(imageBuffer);
        return await analyzeLetterWithAI(text, language);
    }
}

// Routes

// Get user data
app.get('/api/user/:email', async (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email);
        const userId = generateUserId(email);
        
        let user = await db.collection('users').findOne({ userId });
        
        if (!user) {
            // Create new user with 5 free tokens
            user = {
                userId,
                email,
                tokens: 5,
                createdAt: new Date(),
                totalLettersProcessed: 0
            };
            await db.collection('users').insertOne(user);
        }
        
        res.json({
            email: user.email,
            tokens: user.tokens,
            totalLettersProcessed: user.totalLettersProcessed
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// Upload and process files
app.post('/api/upload-and-process', upload.array('files', 10), async (req, res) => {
    try {
        const { email, language = 'es' } = req.body;
        const files = req.files;
        
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        const userId = generateUserId(email);
        
        // Check user tokens
        const user = await db.collection('users').findOne({ userId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.tokens < files.length) {
            return res.status(400).json({ 
                error: `Insufficient tokens. You need ${files.length} tokens but have ${user.tokens}` 
            });
        }
        
        const processedLetters = [];
        
        for (const file of files) {
            try {
                let analysis;
                
                if (file.mimetype === 'application/pdf') {
                    const text = await extractTextFromPDF(file.buffer);
                    analysis = await analyzeLetterWithAI(text, language);
                } else {
                    // Image file - use vision API or OCR
                    analysis = await analyzeImageWithAI(file.buffer, language);
                }
                
                const letter = {
                    userId,
                    filename: file.originalname,
                    fileType: file.mimetype,
                    fileSize: file.size,
                    analysis,
                    language,
                    createdAt: new Date()
                };
                
                const result = await db.collection('letters').insertOne(letter);
                processedLetters.push({
                    id: result.insertedId,
                    filename: file.originalname,
                    analysis
                });
                
            } catch (fileError) {
                console.error(`Error processing file ${file.originalname}:`, fileError);
                processedLetters.push({
                    filename: file.originalname,
                    error: 'Failed to process file'
                });
            }
        }
        
        // Deduct tokens
        await db.collection('users').updateOne(
            { userId },
            { 
                $inc: { 
                    tokens: -files.length,
                    totalLettersProcessed: files.length
                }
            }
        );
        
        res.json({
            message: 'Files processed successfully',
            processedLetters,
            remainingTokens: user.tokens - files.length
        });
        
    } catch (error) {
        console.error('Upload and process error:', error);
        res.status(500).json({ error: 'Failed to process files' });
    }
});

// Get user letters
app.get('/api/letters/:email', async (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email);
        const userId = generateUserId(email);
        
        const letters = await db.collection('letters')
            .find({ userId })
            .sort({ createdAt: -1 })
            .toArray();
        
        res.json(letters);
    } catch (error) {
        console.error('Get letters error:', error);
        res.status(500).json({ error: 'Failed to get letters' });
    }
});

// Get specific letter
app.get('/api/letter/:id', async (req, res) => {
    try {
        const { ObjectId } = require('mongodb');
        const letter = await db.collection('letters').findOne({ 
            _id: new ObjectId(req.params.id) 
        });
        
        if (!letter) {
            return res.status(404).json({ error: 'Letter not found' });
        }
        
        res.json(letter);
    } catch (error) {
        console.error('Get letter error:', error);
        res.status(500).json({ error: 'Failed to get letter' });
    }
});

// Delete letter
app.delete('/api/letter/:id', async (req, res) => {
    try {
        const { ObjectId } = require('mongodb');
        const result = await db.collection('letters').deleteOne({ 
            _id: new ObjectId(req.params.id) 
        });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Letter not found' });
        }
        
        res.json({ message: 'Letter deleted successfully' });
    } catch (error) {
        console.error('Delete letter error:', error);
        res.status(500).json({ error: 'Failed to delete letter' });
    }
});

// Create payment session
app.post('/api/create-payment', async (req, res) => {
    try {
        const { email, tokens, amount } = req.body;
        
        const session = await stripeClient.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `${tokens} Letter Analysis Tokens`,
                            description: 'AI-powered letter analysis tokens for Letter Reader'
                        },
                        unit_amount: Math.round(amount * 100) // Convert to cents
                    },
                    quantity: 1
                }
            ],
            mode: 'payment',
            success_url: `${process.env.DOMAIN}/account.html?email=${encodeURIComponent(email)}&payment=success`,
            cancel_url: `${process.env.DOMAIN}/account.html?email=${encodeURIComponent(email)}&payment=cancelled`,
            metadata: {
                email,
                tokens: tokens.toString()
            }
        });
        
        res.json({ url: session.url });
    } catch (error) {
        console.error('Create payment error:', error);
        res.status(500).json({ error: 'Failed to create payment session' });
    }
});

// Stripe webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripeClient.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const { email, tokens } = session.metadata;
        
        try {
            const userId = generateUserId(email);
            await db.collection('users').updateOne(
                { userId },
                { $inc: { tokens: parseInt(tokens) } }
            );
            
            // Log the purchase
            await db.collection('purchases').insertOne({
                userId,
                email,
                tokens: parseInt(tokens),
                amount: session.amount_total / 100,
                sessionId: session.id,
                createdAt: new Date()
            });
            
            console.log(`Added ${tokens} tokens to user ${email}`);
        } catch (error) {
            console.error('Error processing payment webhook:', error);
        }
    }
    
    res.json({ received: true });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/account.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Letter Reader server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});