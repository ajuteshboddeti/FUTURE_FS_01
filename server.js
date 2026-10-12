require('dotenv').config();

const dns = require('dns');
if (!process.env.VERCEL) {
  try {
    // Use public DNS locally on Windows/local networks
    dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
  } catch (e) {
    // Fall back to system DNS
  }
}

const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const Message = require('./models/Message');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/portfolio_db';

// Cache database connection across serverless invocations
let cachedMongoConn = null;
async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  if (!cachedMongoConn) {
    cachedMongoConn = mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 4000,
      bufferCommands: false
    }).catch(err => {
      console.warn('MongoDB connection notice:', err.message);
      cachedMongoConn = null;
      return null;
    });
  }
  return cachedMongoConn;
}

app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.headers['access-control-request-private-network']) {
    res.header('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return res.status(429).json({
      success: false,
      message: 'Too many requests from this IP address. Please try again after 15 minutes.'
    });
  }
});

const createTransporter = () => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER.trim(),
      pass: process.env.EMAIL_PASS.replace(/\s+/g, '')
    },
    tls: {
      rejectUnauthorized: false
    }
  });
};

const contactValidationRules = [
  body('name')
    .trim()
    .notEmpty().withMessage('Name is required.')
    .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters.'),

  body('email')
    .trim()
    .notEmpty().withMessage('Email is required.')
    .isEmail().withMessage('Please provide a valid email address.')
    .normalizeEmail(),

  body('phone')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]{6,15}$/)
    .withMessage('Please provide a valid phone number (e.g. +91 9876543210).'),

  body('message')
    .trim()
    .notEmpty().withMessage('Message is required.')
    .isLength({ min: 1, max: 2000 })
    .withMessage('Message cannot exceed 2000 characters.')
];

app.post('/api/contact', contactLimiter, contactValidationRules, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed. Please correct the errors and try again.',
      errors: errors.array().map(err => ({
        field: err.path || err.param,
        msg: err.msg
      }))
    });
  }

  const { name, email, phone, message } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  try {
    // Attempt DB connection in serverless context
    await connectToDatabase();

    let savedMessage = null;
    if (mongoose.connection.readyState === 1) {
      try {
        const newMessage = new Message({
          name,
          email,
          phone: phone || '',
          message,
          ipAddress: clientIp
        });
        savedMessage = await newMessage.save();
        console.log(`[MongoDB] Successfully saved message from ${name} (${email}) to database.`);
      } catch (dbErr) {
        console.warn('[MongoDB Save Warning]:', dbErr.message);
      }
    } else {
      console.warn(`[MongoDB Notice] Database not connected. Proceeding with email delivery.`);
    }

    let emailSent = false;
    let emailErrorMessage = null;
    const transporter = createTransporter();

    if (transporter) {
      const recipient = process.env.EMAIL_TO || process.env.EMAIL_USER;
      const mailOptions = {
        from: `"${name}" <${process.env.EMAIL_USER}>`,
        replyTo: email,
        to: recipient,
        subject: `New Portfolio Message from ${name}`,
        text: `You have received a new contact submission:\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone || 'Not provided'}\nTime: ${new Date().toLocaleString()}\nIP: ${clientIp}\n\nMessage:\n${message}\n`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #0f0f0f; color: #f4f4f0; border-radius: 12px; border: 1px solid #262624;">
            <h2 style="color: #cead07; border-bottom: 1px solid #262624; padding-bottom: 12px; margin-top: 0;">New Contact Inquiry</h2>
            <p style="margin: 8px 0;"><strong>Name:</strong> ${name}</p>
            <p style="margin: 8px 0;"><strong>Email:</strong> <a href="mailto:${email}" style="color: #cead07;">${email}</a></p>
            <p style="margin: 8px 0;"><strong>Phone:</strong> ${phone ? phone : '<em>Not provided</em>'}</p>
            <p style="margin: 8px 0;"><strong>Time:</strong> ${new Date().toLocaleString()}</p>
            <div style="margin-top: 20px; padding: 15px; background: #1c1d1d; border-radius: 8px; border-left: 4px solid #cead07;">
              <p style="margin: 0; font-weight: bold; color: #cead07; margin-bottom: 8px;">Message:</p>
              <p style="margin: 0; line-height: 1.6; white-space: pre-wrap;">${message}</p>
            </div>
            <p style="margin-top: 24px; font-size: 12px; color: #61615f;">Sent from your Portfolio Contact Form.</p>
          </div>
        `
      };

      try {
        await transporter.sendMail(mailOptions);
        emailSent = true;
        console.log(`[Nodemailer] Email successfully dispatched to ${recipient}.`);
      } catch (mailError) {
        console.error('[Nodemailer Send Error]:', mailError);
        emailErrorMessage = mailError.message;
      }
    }

    if (savedMessage || emailSent) {
      return res.status(200).json({
        success: true,
        message: 'Thank you! Your message has been sent successfully.',
        data: {
          id: savedMessage ? savedMessage._id : null,
          name,
          email,
          emailDispatched: emailSent
        }
      });
    }

    // If both failed, give meaningful diagnostic info
    return res.status(500).json({
      success: false,
      message: emailErrorMessage 
        ? `Failed to send email: ${emailErrorMessage}`
        : 'Database and email delivery both failed. Check your environment variables on Vercel.'
    });
  } catch (error) {
    console.error('Error processing contact form:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'An error occurred while sending your message. Please try again later.'
    });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', async (req, res) => {
  await connectToDatabase();
  res.json({
    status: 'ok',
    mongoConnected: mongoose.connection.readyState === 1,
    hasEmailUser: Boolean(process.env.EMAIL_USER),
    hasEmailPass: Boolean(process.env.EMAIL_PASS)
  });
});

if (!process.env.VERCEL) {
  connectToDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at http://localhost:${PORT}`);
    console.log(`POST /api/contact endpoint is active with rate limiter (5 req / 15 min).`);
  });
}

module.exports = app;

