import express from 'express';
import User from '../models/User.js';

const router = express.Router();

// GET /api/users/:id - Get user profile
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// PATCH /api/users/:id - Update user info
router.patch('/:id', async (req, res) => {
  try {
    const { githubUrl, portfolioUrl, compensationExpectation, name, phone, isHired } = req.body;

    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (githubUrl !== undefined) user.githubUrl = githubUrl;
    if (portfolioUrl !== undefined) user.portfolioUrl = portfolioUrl;
    if (compensationExpectation !== undefined) user.compensationExpectation = compensationExpectation;
    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (isHired !== undefined) {
      user.isHired = isHired;
      if (isHired && !user.hiredAt) {
        user.hiredAt = new Date();
      } else if (!isHired) {
        user.hiredAt = null;
      }
    }

    await user.save();

    res.json(user);
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

export default router;

