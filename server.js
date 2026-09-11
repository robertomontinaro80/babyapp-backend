require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Inizializzazione Servizi Cloud
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const twilioClient = process.env.TWILIO_ACCOUNT_SID 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) 
  : null;

// Aggiungi questo in server.js per testare la pagina base
app.get('/', (req, res) => {
  res.send('<h1>Server BabyApp Attivo!</h1><p>Le API rispondono su /api/slots</p>');
});

/* -------------------------------------------------------------------------- */
/* 1. DISPONIBILITÀ BABYSITTER                                                */
/* -------------------------------------------------------------------------- */

// Ottieni lista disponibilità aperte
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

// Aggiungi una nuova disponibilità
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

/* -------------------------------------------------------------------------- */
/* 2. RICHIESTA PRENOTAZIONE E NOTIFICA SMS                                   */
/* -------------------------------------------------------------------------- */

app.post('/api/bookings/request', async (req, res) => {
  const { slot_id, family_id, sitter_id, notes, sitter_phone, family_name, booking_date } = req.body;

  try {
    // Registra la prenotazione
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert([{ slot_id, family_id, sitter_id, notes, status: 'requested' }])
      .select()
      .single();

    if (bookingError) throw bookingError;

    // Cambia lo stato dello slot
    await supabase
      .from('availability_slots')
      .update({ status: 'pending' })
      .eq('id', slot_id);

    // Invio notifica SMS se Twilio è configurato
    if (twilioClient && sitter_phone) {
      await twilioClient.messages.create({
        body: `BabyApp: La famiglia ${family_name} ti ha richiesto disponibilità per il giorno ${booking_date}. Accedi all'app per rispondere.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: sitter_phone
      });
    }

    res.status(200).json({ success: true, booking });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/* 3. PAGAMENTO CAPARRA CON STRIPE                                            */
/* -------------------------------------------------------------------------- */

app.post('/api/payments/create-checkout-session', async (req, res) => {
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

// Avvio Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server operativo su http://localhost:${PORT}`));

/* ==========================================================================
   AUTENTICAZIONE UTENTI (SUPABASE AUTH)
   ========================================================================== */

// 1. REGISTRAZIONE UTENTE
app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, phone, role } = req.body;

  try {
    // Registra l'utente in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) throw authError;

    // Salva le informazioni aggiuntive nella tabella users
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

// 2. LOGIN UTENTE
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    // Recupera i dettagli del profilo utente
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
   WEBHOOK STRIPE (Conferma Automatica Pagamento)
   ========================================================================== */

// Nota: Stripe richiede il corpo della richiesta grezzo (raw) per la verifica della firma
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Errore firma Webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gestione dell'evento di pagamento completato
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata.booking_id;

    // 1. Aggiorna la prenotazione come 'accepted'
    await supabase
      .from('bookings')
      .update({ status: 'accepted' })
      .eq('id', bookingId);

    // 2. Recupera lo slot collegato e aggiorna il suo stato a 'booked'
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