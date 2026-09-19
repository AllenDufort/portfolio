import sys
import json
import os
from pathlib import Path
from datetime import datetime, date, timedelta
import pandas as pd
import streamlit as st

# Setup paths to import skill scripts
ROOT_DIR = Path(__file__).parent
SKILL_DIR = ROOT_DIR / ".agents" / "skills" / "travel-planner"
SCRIPTS_DIR = SKILL_DIR / "scripts"

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import travel_db
import plan_generator

# ---------------------------------------------------------------------------
# AI Suggestions Engine (Ollama / Local LLM Integration)
# ---------------------------------------------------------------------------
AVAILABLE_OLLAMA_MODELS = [
    "llama3.1:latest",
    "llama3:latest",
    "mistral:7b",
    "gemma2:27b",
    "granite4:tiny-h",
    "deepseek-r1:8b",
]

def query_ai_model(prompt: str, model_name: str = "granite4:tiny-h", system_prompt: str = "") -> str:
    """Query local Ollama instance with fallback to error notice."""
    try:
        import ollama
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        response = ollama.chat(model=model_name, messages=messages)
        return response["message"]["content"]
    except Exception as e:
        return f"[AI service error: {e}]"


def generate_ai_itinerary_and_recommendations(
    city: str,
    country: str,
    duration: int,
    pace: str,
    budget_level: str,
    activities: list,
    climate: str,
    interests: list,
    dietary: list,
    model_name: str,
) -> tuple:
    """Generate intelligent suggestions (attractions, restaurants, hidden gems, cultural tips, daily plan)."""
    system_prompt = (
        "You are an expert travel concierge and planner adhering to professional travel guidelines. "
        "Provide rich, specific, realistic, and culturally tailored travel recommendations in valid JSON."
    )

    activities_str = ", ".join(activities) if activities else "General sightseeing, dining, exploration"
    interests_str = ", ".join(interests) if interests else "Sightseeing, local culture"
    dietary_str = ", ".join(dietary) if dietary else "None"

    prompt = f"""Generate a comprehensive travel proposal for a vacation to {city}, {country}.
Details:
- Duration: {duration} days
- Pace: {pace} (relaxed = 2 activities/day, moderate = 3 activities/day, packed = 4+ activities/day)
- Budget Level: {budget_level}
- Primary Activities: {activities_str}
- Traveler Interests: {interests_str}
- Dietary restrictions: {dietary_str}
- Climate/Season: {climate}

Output ONLY a JSON object (no markdown, no extra commentary) matching this schema:
{{
  "destination_summary": "1-2 sentences capturing the vibe of {city} for this traveler",
  "top_attractions": [
    {{"name": "Attraction Name", "why_visit": "Why it fits the traveler", "estimated_cost": "$X or Free", "best_time": "Morning/Afternoon"}}
  ],
  "dining_recommendations": [
    {{"restaurant": "Place Name", "cuisine_or_specialty": "Dish/Cuisine", "price_range": "$ / $$ / $$$", "notes": "Dietary or reservation tip"}}
  ],
  "hidden_gems": [
    {{"title": "Gem Name", "description": "Short tip about lesser-known spot or experience"}}
  ],
  "cultural_etiquette_tips": [
    "Tip 1 regarding local customs, dress code, tipping, or greetings",
    "Tip 2",
    "Tip 3"
  ],
  "daily_itinerary": [
    {{
      "day": 1,
      "theme": "Theme for the day (e.g. Historic Heart & Sunset Views)",
      "morning": {{"time": "9:00 AM - 12:00 PM", "activity": "Specific attraction/activity", "notes": "Helpful tip"}},
      "afternoon": {{"time": "1:30 PM - 5:00 PM", "activity": "Specific attraction/activity", "notes": "Helpful tip"}},
      "evening": {{"time": "6:30 PM - 9:30 PM", "activity": "Specific dining/entertainment", "notes": "Helpful tip"}},
      "meals": {{"breakfast": "Cafe/dish idea", "lunch": "Local lunch spot/type", "dinner": "Dinner recommendation"}}
    }}
  ]
}}
Provide daily_itinerary with all {min(duration, 7)} days populated with real, specific locations in {city}."""

    raw_response = query_ai_model(prompt, model_name=model_name, system_prompt=system_prompt)

    try:
        cleaned = raw_response.strip()
        if "```json" in cleaned:
            cleaned = cleaned.split("```json")[1].split("```")[0].strip()
        elif "```" in cleaned:
            cleaned = cleaned.split("```")[1].split("```")[0].strip()
        return json.loads(cleaned), None
    except Exception as parse_err:
        return None, raw_response


# ---------------------------------------------------------------------------
# Page Configuration
# ---------------------------------------------------------------------------
st.set_page_config(
    page_title="AI Travel Planner",
    page_icon="✈️",
    layout="wide",
    initial_sidebar_state="expanded",
)


# ---------------------------------------------------------------------------
# Page 1: Dashboard & Trip Overview
# ---------------------------------------------------------------------------
def page_dashboard():
    st.title("✈️ Travel Planner Dashboard")
    st.caption("Plan, manage, and track your trips using the Travel Planner skill.")

    stats = travel_db.get_travel_stats()

    col1, col2, col3, col4, col5 = st.columns(5)
    with col1:
        st.metric("Total Past Trips", stats.get("total_trips", 0))
    with col2:
        st.metric("Active Trips", stats.get("current_trips", 0))
    with col3:
        st.metric("Countries Visited", stats.get("countries_visited", 0))
    with col4:
        st.metric("Days Traveled", stats.get("total_days_traveled", 0))
    with col5:
        st.metric("Total Spent", f"${stats.get('total_spent', 0):,.2f}")

    st.markdown("---")

    trips_data = travel_db.get_trips("all")
    current_trips = trips_data.get("current_trips", [])
    past_trips = trips_data.get("past_trips", [])
    trip_ideas = trips_data.get("trip_ideas", [])

    st.subheader("🛫 Current & Upcoming Trips")
    if current_trips:
        for trip in current_trips:
            dest = trip.get("destination", {})
            dest_name = f"{dest.get('city', 'Unknown')}, {dest.get('country', '')}".strip(", ")
            with st.expander(f"📍 {dest_name} ({trip.get('departure_date', 'TBD')} to {trip.get('return_date', 'TBD')})", expanded=True):
                c1, c2, c3 = st.columns(3)
                with c1:
                    st.write(f"**Duration:** {trip.get('duration_days', 'N/A')} days")
                    st.write(f"**Climate:** {trip.get('climate', 'N/A')}")
                with c2:
                    budget = trip.get("budget", {})
                    st.write(f"**Total Budget:** ${budget.get('total', 0):,.2f}")
                    st.write(f"**Spent:** ${budget.get('spent', 0):,.2f}")
                with c3:
                    st.write(f"**Activities:** {', '.join(trip.get('activities', [])) or 'None specified'}")

                bcol1, bcol2, _ = st.columns([1, 1, 4])
                with bcol1:
                    if st.button("Mark Completed ✅", key=f"complete_{trip.get('id')}"):
                        travel_db.move_trip_to_past(trip.get("id"))
                        dest_country = dest.get("country")
                        if dest_country:
                            travel_db.add_previous_destination(f"{dest.get('city', '')}, {dest_country}".strip(", "))
                        st.success("Moved trip to past trips!")
                        st.rerun()
                with bcol2:
                    if st.button("Delete 🗑️", key=f"del_curr_{trip.get('id')}"):
                        travel_db.delete_trip(trip.get("id"))
                        st.warning("Trip deleted.")
                        st.rerun()
    else:
        st.info("No active trips yet. Go to **Plan New Trip (with AI)** to create one with AI suggestions!")

    st.markdown("---")

    col_past, col_ideas = st.columns(2)

    with col_past:
        st.subheader("📜 Past Trips")
        if past_trips:
            for trip in past_trips:
                dest = trip.get("destination", {})
                dest_name = f"{dest.get('city', '')}, {dest.get('country', '')}".strip(", ")
                with st.expander(f"🏛️ {dest_name} ({trip.get('duration_days', 0)} days)"):
                    st.write(f"**Dates:** {trip.get('departure_date', '')} - {trip.get('return_date', '')}")
                    budget = trip.get("budget", {})
                    st.write(f"**Spent:** ${budget.get('spent', 0):,.2f} / ${budget.get('total', 0):,.2f}")
                    if st.button("Delete", key=f"del_past_{trip.get('id')}"):
                        travel_db.delete_trip(trip.get("id"))
                        st.rerun()
        else:
            st.write("No past trips recorded yet.")

    with col_ideas:
        st.subheader("💡 Trip Ideas")
        if trip_ideas:
            for idea in trip_ideas:
                dest = idea.get("destination", {})
                dest_name = f"{dest.get('city', '')}, {dest.get('country', '')}".strip(", ")
                with st.expander(f"✨ {dest_name}"):
                    st.write(f"**Notes:** {idea.get('notes', 'No notes')}")
                    if st.button("Delete", key=f"del_idea_{idea.get('id')}"):
                        travel_db.delete_trip(idea.get("id"))
                        st.rerun()
        else:
            st.write("No trip ideas saved yet.")


# ---------------------------------------------------------------------------
# Page 2: Plan New Trip with AI Suggestions
# ---------------------------------------------------------------------------
def page_plan_trip():
    st.title("🗺️ Plan a New Trip with AI Suggestions")
    st.caption("Let AI generate custom vacation recommendations, tailored itineraries, dining spots, and local tips.")

    prefs = travel_db.get_preferences()

    with st.sidebar.expander("🤖 AI Model Settings", expanded=False):
        selected_model = st.selectbox("LLM Model", AVAILABLE_OLLAMA_MODELS, index=0)
        st.caption("Powered by local Ollama instance.")

    st.subheader("1. Where & When")
    col1, col2 = st.columns(2)
    with col1:
        city = st.text_input("Destination City", "Rome", key="input_city")
        country = st.text_input("Destination Country", "Italy", key="input_country")
        climate = st.selectbox("Climate / Season", ["Temperate / Spring & Fall", "Warm / Summer / Tropical", "Cold / Winter"], index=0, key="input_climate")
    with col2:
        dep_date = st.date_input("Departure Date", date.today() + timedelta(days=30), key="input_dep_date")
        duration = st.number_input("Duration (Days)", min_value=1, max_value=30, value=5, key="input_duration")
        ret_date = dep_date + timedelta(days=int(duration))
        st.success(f"📅 **Trip Window:** {dep_date.strftime('%a, %b %d, %Y')} ➔ **{ret_date.strftime('%a, %b %d, %Y')}** ({duration} {'day' if duration == 1 else 'days'})")

    with st.form("new_trip_form"):
        st.subheader("2. Travel Style & Budget")
        col3, col4 = st.columns(2)
        with col3:
            total_budget = st.number_input("Total Budget ($ USD)", min_value=100.0, max_value=100000.0, value=2500.0, step=100.0)
            budget_level = st.selectbox(
                "Budget Tier",
                ["budget", "mid-range", "luxury"],
                index=["budget", "mid-range", "luxury"].index(prefs.get("budget_level", "mid-range"))
                if prefs.get("budget_level") in ["budget", "mid-range", "luxury"] else 1
            )
        with col4:
            pace = st.selectbox(
                "Pace Preference",
                ["relaxed", "moderate", "packed"],
                index=["relaxed", "moderate", "packed"].index(prefs.get("pace_preference", "moderate"))
                if prefs.get("pace_preference") in ["relaxed", "moderate", "packed"] else 1
            )
            activity_options = ["sightseeing", "cultural & museums", "food & wine tasting", "hiking & nature", "beach & relaxation", "nightlife", "shopping", "photography"]
            activities = st.multiselect(
                "Planned Activity Types",
                activity_options,
                default=[a for a in ["sightseeing", "cultural & museums", "food & wine tasting"] if a in activity_options]
            )

        status = st.radio("Save trip as:", ["Current / Upcoming Trip", "Trip Idea"], horizontal=True)

        submitted = st.form_submit_button("✨ Generate AI Vacation Plan & Suggestions", use_container_width=True)

    if submitted:
        with st.spinner(f"Generating tailored AI suggestions for {city}, {country} using {selected_model}..."):
            # Call AI Engine
            ai_data, raw_ai_text = generate_ai_itinerary_and_recommendations(
                city=city.strip(),
                country=country.strip(),
                duration=int(duration),
                pace=pace,
                budget_level=budget_level,
                activities=activities,
                climate=climate,
                interests=prefs.get("interests", []),
                dietary=prefs.get("dietary_restrictions", []),
                model_name=selected_model,
            )

            trip_data = {
                "destination": {"city": city.strip(), "country": country.strip()},
                "departure_date": dep_date.strftime("%Y-%m-%d"),
                "return_date": ret_date.strftime("%Y-%m-%d"),
                "duration_days": int(duration),
                "climate": climate.lower(),
                "activities": activities,
                "budget": {"total": float(total_budget), "spent": 0.0},
                "expenses": [],
            }

            trip_status = "current" if status == "Current / Upcoming Trip" else "idea"
            trip_id = travel_db.add_trip(trip_data, status=trip_status)

            # Fallback baseline plan
            base_plan = plan_generator.generate_trip_plan(trip_data)

            # Integrate AI results into stored trip
            itinerary = (ai_data.get("daily_itinerary") if ai_data and "daily_itinerary" in ai_data else base_plan.get("itinerary", []))
            ai_recommendations = {
                "summary": ai_data.get("destination_summary", "") if ai_data else "",
                "attractions": ai_data.get("top_attractions", []) if ai_data else [],
                "dining": ai_data.get("dining_recommendations", []) if ai_data else [],
                "hidden_gems": ai_data.get("hidden_gems", []) if ai_data else [],
                "etiquette": ai_data.get("cultural_etiquette_tips", []) if ai_data else [],
                "raw": raw_ai_text if raw_ai_text else ""
            }

            travel_db.update_trip(trip_id, {
                "itinerary": itinerary,
                "ai_recommendations": ai_recommendations,
                "packing_checklist": base_plan.get("packing_checklist", {}),
                "pre_trip_checklist": base_plan.get("pre_trip_checklist", []),
                "budget_breakdown": base_plan.get("budget", {}),
            })

            st.success(f"🎉 Custom vacation plan for {city}, {country} generated and saved!")
            st.session_state["selected_trip_id"] = trip_id

    # Display Trip Details & AI Suggestions
    active_trips = travel_db.get_trips("current").get("current_trips", [])
    if active_trips:
        st.markdown("---")
        st.subheader("📋 Vacation Plan & AI Suggestions")
        trip_lookup = {
            f"{t.get('destination', {}).get('city', '')}, {t.get('destination', {}).get('country', '')} ({t.get('departure_date', '')})": t.get("id")
            for t in active_trips
        }
        selected_label = st.selectbox("Select Trip to Review:", list(trip_lookup.keys()))
        selected_id = trip_lookup[selected_label]
        trip = travel_db.get_trip_by_id(selected_id)

        if trip:
            ai_rec = trip.get("ai_recommendations", {})

            if ai_rec.get("summary"):
                st.info(f"💡 **AI Destination Vibe:** {ai_rec.get('summary')}")

            plan_tabs = st.tabs([
                "🌟 AI Suggestions & Highlights",
                "📅 Daily Itinerary",
                "💰 Budget Breakdown",
                "🎒 Packing Checklist",
                "⏰ Pre-Trip Timeline"
            ])

            # Tab 1: AI Suggestions & Highlights
            with plan_tabs[0]:
                col_attr, col_food = st.columns(2)
                with col_attr:
                    st.markdown("### 🏛️ Top Recommended Attractions")
                    attractions = ai_rec.get("attractions", [])
                    if attractions:
                        for attr in attractions:
                            st.markdown(f"**• {attr.get('name')}** ({attr.get('estimated_cost', 'N/A')})")
                            st.caption(f"{attr.get('why_visit', '')} — *Best time:* {attr.get('best_time', 'Anytime')}")
                    else:
                        st.write("No specific attraction items recorded.")

                with col_food:
                    st.markdown("### 🍽️ Dining & Culinary Recommendations")
                    dining = ai_rec.get("dining", [])
                    if dining:
                        for d in dining:
                            st.markdown(f"**• {d.get('restaurant')}** ({d.get('price_range', '$$')})")
                            st.caption(f"Specialty: {d.get('cuisine_or_specialty', '')} | Note: {d.get('notes', '')}")
                    else:
                        st.write("No specific dining items recorded.")

                st.markdown("---")
                col_gems, col_etiq = st.columns(2)
                with col_gems:
                    st.markdown("### 💎 Hidden Gems & Local Secrets")
                    gems = ai_rec.get("hidden_gems", [])
                    if gems:
                        for gem in gems:
                            st.markdown(f"**• {gem.get('title')}**")
                            st.caption(gem.get("description", ""))
                    else:
                        st.write("Explore local alleys and ask residents for secret spots!")

                with col_etiq:
                    st.markdown("### 🤝 Local Cultural Etiquette Tips")
                    etiquette = ai_rec.get("etiquette", [])
                    if etiquette:
                        for tip in etiquette:
                            st.markdown(f"- {tip}")
                    else:
                        st.write("Review the guidelines tab for comprehensive etiquette.")

            # Tab 2: Daily Itinerary
            with plan_tabs[1]:
                itinerary = trip.get("itinerary", [])
                if itinerary:
                    for day_info in itinerary:
                        theme_str = f" — {day_info.get('theme')}" if day_info.get("theme") else ""
                        with st.expander(f"📍 Day {day_info.get('day')}{theme_str}", expanded=True):
                            c_m, c_a, c_e = st.columns(3)
                            with c_m:
                                m = day_info.get("morning", {})
                                st.markdown(f"**🌅 Morning ({m.get('time', '9:00 AM')})**")
                                st.write(m.get("activity", "Free exploration"))
                                if m.get("notes"):
                                    st.caption(f"💡 {m.get('notes')}")
                            with c_a:
                                a = day_info.get("afternoon", {})
                                st.markdown(f"**☀️ Afternoon ({a.get('time', '2:00 PM')})**")
                                st.write(a.get("activity", "Free exploration"))
                                if a.get("notes"):
                                    st.caption(f"💡 {a.get('notes')}")
                            with c_e:
                                e = day_info.get("evening", {})
                                if e:
                                    st.markdown(f"**🌙 Evening ({e.get('time', '7:00 PM')})**")
                                    st.write(e.get("activity", "Dinner & relaxation"))
                                    if e.get("notes"):
                                        st.caption(f"💡 {e.get('notes')}")
                            meals = day_info.get("meals", {})
                            st.markdown(
                                f"🍴 **Meals:** Breakfast: *{meals.get('breakfast', 'Local cafe')}* | "
                                f"Lunch: *{meals.get('lunch', 'Market/Trattoria')}* | "
                                f"Dinner: *{meals.get('dinner', 'Specialty restaurant')}*"
                            )
                else:
                    st.info("No detailed itinerary available.")

            # Tab 3: Budget Breakdown
            with plan_tabs[2]:
                b_breakdown = trip.get("budget_breakdown", {})
                if not b_breakdown:
                    b_breakdown = plan_generator.calculate_budget_breakdown(
                        trip.get("budget", {}).get("total", 0),
                        trip.get("duration_days", 1)
                    )
                categories = b_breakdown.get("breakdown", {})
                b_rows = []
                for cat, info in categories.items():
                    b_rows.append({
                        "Category": cat.capitalize(),
                        "Total Allocation ($)": f"${info.get('total', 0):,.2f}",
                        "Per Day ($)": f"${info.get('per_day', 0):,.2f}",
                        "Share": f"{info.get('percentage', 0):.1f}%"
                    })
                st.dataframe(pd.DataFrame(b_rows), hide_index=True, use_container_width=True)
                st.write(f"**Daily Target Average:** ${b_breakdown.get('daily_average', 0):,.2f}")

            # Tab 4: Packing Checklist
            with plan_tabs[3]:
                packing = trip.get("packing_checklist", {})
                if not packing:
                    packing = plan_generator.generate_packing_checklist(
                        trip.get("climate", "moderate"),
                        trip.get("duration_days", 7),
                        trip.get("activities", [])
                    )
                for category, items in packing.items():
                    st.markdown(f"#### {category.capitalize()}")
                    cols = st.columns(2)
                    for idx, item in enumerate(items):
                        with cols[idx % 2]:
                            st.checkbox(item, key=f"pack_{selected_id}_{category}_{idx}")

            # Tab 5: Pre-Trip Timeline
            with plan_tabs[4]:
                timeline = trip.get("pre_trip_checklist", [])
                if not timeline:
                    timeline = plan_generator.generate_pre_trip_checklist(
                        trip.get("destination", {}).get("country", ""),
                        trip.get("departure_date", "")
                    )
                for section in timeline:
                    st.markdown(f"#### ⏳ {section.get('timeline')}")
                    for tidx, task in enumerate(section.get("tasks", [])):
                        st.checkbox(task, key=f"time_{selected_id}_{section.get('timeline')}_{tidx}")


# ---------------------------------------------------------------------------
# Page 3: Ask AI Travel Concierge (Interactive Chat / Questions)
# ---------------------------------------------------------------------------
def page_ai_concierge():
    st.title("💬 Ask AI Travel Concierge")
    st.caption("Ask questions about any destination, ask for packing advice, hotel ideas, or custom day trips.")

    col1, col2 = st.columns([3, 1])
    with col2:
        model = st.selectbox("AI Model", AVAILABLE_OLLAMA_MODELS, index=0, key="chat_model")
        if st.button("Clear Chat History", use_container_width=True):
            st.session_state["travel_chat_messages"] = []
            st.rerun()

    if "travel_chat_messages" not in st.session_state:
        st.session_state["travel_chat_messages"] = [
            {"role": "assistant", "content": "Hello! Where are you planning to travel next? Ask me for custom recommendations, packing tips, or local secrets!"}
        ]

    for msg in st.session_state["travel_chat_messages"]:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])

    if prompt := st.chat_input("Ask anything (e.g. 'What are the best cafes in Florence with vegan options?')"):
        st.session_state["travel_chat_messages"].append({"role": "user", "content": prompt})
        with st.chat_message("user"):
            st.markdown(prompt)

        with st.chat_message("assistant"):
            with st.spinner("Consulting AI concierge..."):
                prefs = travel_db.get_preferences()
                sys_msg = (
                    f"You are an expert travel consultant. The user's travel preferences are: "
                    f"Interests: {prefs.get('interests', [])}, Dietary: {prefs.get('dietary_restrictions', [])}, "
                    f"Pace: {prefs.get('pace_preference', 'moderate')}. Provide helpful, structured, engaging advice."
                )
                answer = query_ai_model(prompt, model_name=model, system_prompt=sys_msg)
                st.markdown(answer)
                st.session_state["travel_chat_messages"].append({"role": "assistant", "content": answer})


# ---------------------------------------------------------------------------
# Page 4: Budget & Expense Tracker
# ---------------------------------------------------------------------------
def page_budget_tracker():
    st.title("💵 Budget & Expense Tracker")
    st.caption("Track daily expenses and monitor budget allocations per trip.")

    all_trips = travel_db.get_trips("current").get("current_trips", []) + travel_db.get_trips("past").get("past_trips", [])
    if not all_trips:
        st.info("No trips found. Create a trip first in **Plan New Trip (with AI)**.")
        return

    trip_map = {
        f"{t.get('destination', {}).get('city', '')}, {t.get('destination', {}).get('country', '')} (ID: {t.get('id', '')[:8]})": t.get("id")
        for t in all_trips
    }
    selected_label = st.selectbox("Select Trip:", list(trip_map.keys()))
    trip_id = trip_map[selected_label]

    summary = travel_db.get_budget_summary(trip_id)
    total_budget = summary.get("total_budget", 0)
    spent = summary.get("spent", 0)
    remaining = summary.get("remaining", 0)
    pct = summary.get("percentage_used", 0)

    m1, m2, m3, m4 = st.columns(4)
    with m1:
        st.metric("Total Budget", f"${total_budget:,.2f}")
    with m2:
        st.metric("Spent", f"${spent:,.2f}")
    with m3:
        st.metric("Remaining", f"${remaining:,.2f}", delta=f"{100-pct:.1f}% left")
    with m4:
        st.progress(min(pct / 100.0, 1.0), text=f"{pct:.1f}% Used")

    st.markdown("---")

    col_add, col_list = st.columns([1, 2])

    with col_add:
        st.subheader("➕ Log Expense")
        with st.form("add_expense_form"):
            exp_desc = st.text_input("Description", "Dinner at Trattoria")
            exp_amount = st.number_input("Amount ($ USD)", min_value=0.01, value=35.0, step=1.0)
            exp_category = st.selectbox(
                "Category",
                ["Accommodation", "Food", "Activities", "Transportation", "Miscellaneous"]
            )
            exp_date = st.date_input("Date", date.today())
            exp_submit = st.form_submit_button("Add Expense", use_container_width=True)

            if exp_submit:
                expense_obj = {
                    "description": exp_desc,
                    "amount": float(exp_amount),
                    "category": exp_category,
                    "date": exp_date.strftime("%Y-%m-%d")
                }
                travel_db.add_expense(trip_id, expense_obj)
                st.success("Expense recorded!")
                st.rerun()

    with col_list:
        st.subheader("📊 Expense History & Breakdown")
        expenses = travel_db.get_trip_expenses(trip_id)
        if expenses:
            df_exp = pd.DataFrame(expenses)[["date", "description", "category", "amount"]]
            df_exp.columns = ["Date", "Description", "Category", "Amount ($)"]
            st.dataframe(df_exp, hide_index=True, use_container_width=True)

            by_cat = summary.get("by_category", {})
            if by_cat:
                st.write("**Spending by Category:**")
                df_cat = pd.DataFrame([{"Category": k, "Amount ($)": v} for k, v in by_cat.items()])
                st.bar_chart(df_cat.set_index("Category"))
        else:
            st.write("No expenses logged yet.")


# ---------------------------------------------------------------------------
# Page 5: User Profile & Preferences
# ---------------------------------------------------------------------------
def page_preferences():
    st.title("👤 Traveler Profile & Preferences")
    st.caption("Manage your travel style, dietary requirements, bucket list, and past destinations.")

    prefs = travel_db.get_preferences()

    with st.form("preferences_form"):
        col1, col2 = st.columns(2)
        with col1:
            travel_style = st.selectbox(
                "Travel Style",
                ["Backpacking / Solo", "Cultural & Sightseeing", "Relaxed & Resort", "Adventure & Nature", "Luxury & Fine Dining"],
                index=0
            )
            budget_level = st.selectbox(
                "Default Budget Level",
                ["budget", "mid-range", "luxury"],
                index=["budget", "mid-range", "luxury"].index(prefs.get("budget_level", "mid-range"))
                if prefs.get("budget_level") in ["budget", "mid-range", "luxury"] else 1
            )
            pace_pref = st.selectbox(
                "Pace Preference",
                ["relaxed", "moderate", "packed"],
                index=["relaxed", "moderate", "packed"].index(prefs.get("pace_preference", "moderate"))
                if prefs.get("pace_preference") in ["relaxed", "moderate", "packed"] else 1
            )
            companions = st.text_input("Frequent Travel Companions", prefs.get("travel_companions", "Solo / Partner"))

        with col2:
            interests_input = st.text_area(
                "Interests (comma-separated)",
                ", ".join(prefs.get("interests", [])) or "history, food, photography, hiking"
            )
            dietary_input = st.text_area(
                "Dietary Restrictions (comma-separated)",
                ", ".join(prefs.get("dietary_restrictions", [])) or "None"
            )
            languages_input = st.text_input(
                "Languages Spoken (comma-separated)",
                ", ".join(prefs.get("language_skills", [])) or "English"
            )

        save_btn = st.form_submit_button("Save Preferences", use_container_width=True)

    if save_btn:
        updated_prefs = {
            "travel_style": travel_style,
            "budget_level": budget_level,
            "pace_preference": pace_pref,
            "travel_companions": companions,
            "interests": [i.strip() for i in interests_input.split(",") if i.strip()],
            "dietary_restrictions": [d.strip() for d in dietary_input.split(",") if d.strip()],
            "language_skills": [l.strip() for l in languages_input.split(",") if l.strip()],
        }
        travel_db.save_preferences(updated_prefs)
        st.success("Preferences updated successfully!")

    st.markdown("---")

    # Bucket List Management
    b_col1, b_col2 = st.columns(2)
    with b_col1:
        st.subheader("🌍 Bucket List Destinations")
        bucket_list = prefs.get("bucket_list", [])
        if bucket_list:
            for b in bucket_list:
                st.write(f"- **{b.get('destination')}**: {b.get('notes', '')}")
        else:
            st.caption("No bucket list items yet.")

        with st.form("add_bucket_form"):
            new_dest = st.text_input("New Bucket List Destination", "Reykjavik, Iceland")
            new_notes = st.text_input("Notes / Goals", "Northern lights and hot springs")
            if st.form_submit_button("Add to Bucket List"):
                travel_db.add_to_bucket_list(new_dest, new_notes)
                st.success(f"Added {new_dest} to bucket list!")
                st.rerun()

    with b_col2:
        st.subheader("🗺️ Previous Destinations")
        prev_dest = prefs.get("previous_destinations", [])
        if prev_dest:
            for p in prev_dest:
                st.write(f"- {p}")
        else:
            st.caption("No previous destinations logged.")

        with st.form("add_prev_dest_form"):
            prev_input = st.text_input("Add Visited Destination", "Paris, France")
            if st.form_submit_button("Add to Visited"):
                travel_db.add_previous_destination(prev_input)
                st.success(f"Added {prev_input} to visited places!")
                st.rerun()


# ---------------------------------------------------------------------------
# Main App Router
# ---------------------------------------------------------------------------
def main():
    st.sidebar.title("✈️ AI Travel Planner")
    st.sidebar.markdown(
        '<a href="https://allendufort.github.io/portfolio/" target="_self" style="display:inline-block;margin-bottom:0.75rem;padding:0.35rem 0.85rem;'
        'background:#262730;border:1px solid #555;border-radius:6px;color:#fafafa;text-decoration:none;font-size:0.875rem;">'
        '🏠 Portfolio Home</a>',
        unsafe_allow_html=True,
    )
    st.sidebar.markdown("---")
    page = st.sidebar.radio(
        "Navigation",
        [
            "📊 Dashboard",
            "🗺️ Plan New Trip (with AI)",
            "💬 Ask AI Concierge",
            "💵 Budget & Expenses",
            "👤 Traveler Profile",
        ],
        label_visibility="collapsed",
    )

    if page == "📊 Dashboard":
        page_dashboard()
    elif page == "🗺️ Plan New Trip (with AI)":
        page_plan_trip()
    elif page == "💬 Ask AI Concierge":
        page_ai_concierge()
    elif page == "💵 Budget & Expenses":
        page_budget_tracker()
    elif page == "👤 Traveler Profile":
        page_preferences()


if __name__ == "__main__":
    main()
