require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();

/* ==========================================================================
   WEBHOOK STRIPE (Deve stare PRIMA di express.json())
   ========================================================================== */
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe non configurato.');
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Errore firma Webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata.booking_id;

    await supabase
      .from('bookings')
      .update({ status: 'accepted' })
      .eq('id', bookingId);

    const { data: booking } = await supabase
      .from('bookings')
      .select('slot_id')
      .eq('id', bookingId)
      .single();

    if (booking) {
      await supabase
        .from('availability_slots')
        .update({ status: 'booked' })
        .eq('id', booking.slot_id);
    }

    console.log(`Prenotazione ${bookingId} confermata con successo!`);
  }

  res.json({ received: true });
});

// Middleware standard per le altre rotte
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

/* ==========================================================================
   INIZIALIZZAZIONE SERVIZI CLOUD
   ========================================================================== */

// 1. Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 2. Twilio (Opzionale)
const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// 3. Stripe (Opzionale)
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

/* ==========================================================================
   ROTTE BASE & AUTENTICAZIONE
   ========================================================================== */

app.get('/', (req, res) => {
  res.send('<h1>Server BabyApp Attivo!</h1><p>Le API rispondono su /api/slots</p>');
});

// Registrazione
app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, phone, role } = req.body;

  try {
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) throw authError;

    const { error: dbError } = await supabase.from('users').insert([
      {
        id: authData.user.id,
        email,
        full_name,
        phone,
        role: role || 'family',
      },
    ]);

    if (dbError) throw dbError;

    res.status(201).json({ success: true, message: 'Registrazione completata!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    const { data: profile } = await supabase
      .from('users')
      .select('*')
      .eq('id', data.user.id)
      .single();

    res.json({
      success: true,
      token: data.session.access_token,
      user: profile,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   DISPONIBILITÀ (SLOTS)
   ========================================================================== */

// Lista disponibilità aperte
app.get('/api/slots', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('availability_slots')
      .select('*, users(full_name, phone)')
      .eq('status', 'available');

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Aggiungi nuova disponibilità
app.post('/api/slots', async (req, res) => {
  const { sitter_id, slot_date, time_slot, hourly_rate } = req.body;
  try {
    const { data, error } = await supabase
      .from('availability_slots')
      .insert([{ sitter_id, slot_date, time_slot, hourly_rate, status: 'available' }])
      .select();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   PRENOTAZIONI & NOTIFICHE SMS
   ========================================================================== */

   // 1. Recupera prenotazioni per l'utente (Babysitter o Famiglia)
app.get('/api/bookings', async (req, res) => {
  const { userId, role } = req.query;

  if (!userId || !role) {
    return res.status(400).json({ success: false, error: 'Parametri mancanti.' });
  }

  const columnFilter = role === 'sitter' ? 'sitter_id' : 'family_id';

  const { data, error } = await supabase
    .from('bookings')
    .select(`
      id,
      status,
      notes,
      booking_date,
      created_at,
      slots ( time_slot, hourly_rate ),
      family:users!bookings_family_id_fkey ( full_name, phone ),
      sitter:users!bookings_sitter_id_fkey ( full_name, phone )
    `)
    .eq(columnFilter, userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, data });
});

// 2. La Babysitter Accetta o Rifiuta una prenotazione
app.post('/api/bookings/respond', async (req, res) => {
  const { booking_id, status } = req.body; // status: 'confirmed' o 'rejected'

  if (!['confirmed', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Stato non valido.' });
  }

  const { data, error } = await supabase
    .from('bookings')
    .update({ status })
    .eq('id', booking_id)
    .select();

  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, message: `Prenotazione ${status === 'confirmed' ? 'accettata' : 'rifiutata'}.` });
});

app.post('/api/bookings/request', async (req, res) => {
  const { slot_id, family_id, sitter_id, notes, sitter_phone, family_name, booking_date } = req.body;

  try {
    // 1. Salva prenotazione
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert([{ slot_id, family_id, sitter_id, notes, status: 'requested' }])
      .select()
      .single();

    if (bookingError) throw bookingError;

    // 2. Aggiorna stato slot
    await supabase
      .from('availability_slots')
      .update({ status: 'pending' })
      .eq('id', slot_id);

    // 3. Invio SMS se Twilio è configurato
    if (twilioClient && sitter_phone) {
      try {
        await twilioClient.messages.create({
          body: `BabyApp: La famiglia ${family_name || 'una famiglia'} ti ha richiesto la disponibilità per il giorno ${booking_date}. Accedi per rispondere!`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: sitter_phone
        });
        console.log(`SMS inviato a ${sitter_phone}`);
      } catch (smsError) {
        console.error("Errore invio SMS:", smsError.message);
      }
    }

    res.status(200).json({ success: true, booking, message: "Prenotazione inviata!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   PAGAMENTI STRIPE
   ========================================================================== */

app.post('/api/payments/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.json({
      success: true,
      offline: true,
      message: "Stripe non configurato. Pagamento registrato in modalità offline."
    });
  }

  const { booking_id, amount_eur, sitter_name } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: `Caparra prenotazione Babysitter: ${sitter_name}`,
            },
            unit_amount: Math.round(amount_eur * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL}/success.html?booking_id=${booking_id}`,
      cancel_url: `${process.env.CLIENT_URL}/cancel.html`,
      metadata: { booking_id },
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ==========================================================================
   RECUPERO E RESET PASSWORD
   ========================================================================== */

// 1. Richiesta invio email di reset
app.post('/api/auth/reset-password-request', async (req, res) => {
  const { email } = req.body;

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.CLIENT_URL}/reset-password.html`,
    });

    if (error) throw error;

    res.json({ success: true, message: "Email di ripristino inviata con successo!" });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 2. Impostazione della nuova password
// app.post('/api/auth/update-password', async (req, res) => {
//   const { new_password, access_token } = req.body;

//   try {
//     // Imposta la sessione dell'utente usando il token inviato da Supabase via email
//     const { error: sessionError } = await supabase.auth.setSession({
//       access_token,
//       refresh_token: '', // Non necessario per l'aggiornamento password
//     });

//     if (sessionError) throw sessionError;

//     // Aggiorna la password
//     const { error } = await supabase.auth.updateUser({
//       password: new_password
//     });

//     if (error) throw error;

//     res.json({ success: true, message: "Password aggiornata con successo!" });
//   } catch (err) {
//     res.status(400).json({ success: false, error: err.message });
//   }
// });

// Endpoint per passare la configurazione pubblica al Frontend
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

/* ==========================================================================
   AVVIO SERVER
   ========================================================================== */

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server operativo su http://localhost:${PORT}`));