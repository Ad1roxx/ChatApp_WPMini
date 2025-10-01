import { create } from 'zustand';

const useStore = create((set) => ({
  announcements: [
    { id: 1, text: "Welcome to the new semester!", time: "10:00 AM" },
    { id: 2, text: "Please check the updated syllabus.", time: "11:30 AM" },
  ],
  addAnnouncement: (announcement) =>
    set((state) => ({ announcements: [...state.announcements, announcement] })),
}));

export default useStore;
